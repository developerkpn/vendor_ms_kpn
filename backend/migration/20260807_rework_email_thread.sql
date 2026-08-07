-- Rework approver e-mail thread: outbound mails + their inbound replies.
-- Created: 2026-08-07
-- Purpose:
-- 1. Persist the mail Master Data actually sent to the hand-picked rework
--    approver (chain replacement, notifyVia='EMAIL'), so the request detail can
--    show WHAT was asked, not just that "an email was sent".
-- 2. Persist the approver's replies pulled back off IMAP, threaded to the mail
--    they answer, so the review lands in VMS instead of one MDM user's inbox.
-- 3. Keep an IMAP poll cursor per mailbox, so the poller never rescans the
--    ~14k message history sitting in that box.
--
-- Threading is by RFC 5322 Message-ID: mat_rework_email.message_id is what the
-- SMTP server handed back on send, and a reply carries it in In-Reply-To /
-- References. The subject token [VMS#<request_no>] is the fallback for clients
-- that drop those headers; it is not stored separately because the subject the
-- mail went out with is stored verbatim.
--
-- request_kind + request_id, not two nullable FKs: a rework mail belongs to
-- EITHER a mat_single_request row OR a mat_mass_request row, and the two id
-- spaces are independent sequences. No FK for the same reason — one column
-- cannot reference two tables.
--
-- Thread identity per kind (mirrors what requestSingleRequestRework /
-- requestMassRequestRework already lock and gate on):
--   SINGLE -> mat_single_request.request_no
--   MASS   -> the request_no of the batch's FIRST item (item_no ASC), which is
--             the exact row requestMassRequestRework locks FOR UPDATE and
--             status-gates the whole batch on.

BEGIN;

CREATE TABLE IF NOT EXISTS public.mat_rework_email (
    id bigserial PRIMARY KEY,
    request_kind varchar(10) NOT NULL,
    request_id bigint NOT NULL,
    message_id text NULL,
    subject text NOT NULL,
    body text NOT NULL,
    to_email varchar(255) NOT NULL,
    to_user_id varchar(100) NULL,
    sent_by_user_id varchar(100) NULL,
    send_status varchar(20) NOT NULL DEFAULT 'SENT',
    send_error text NULL,
    sent_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_mat_rework_email_message_id UNIQUE (message_id),
    CONSTRAINT chk_mat_rework_email_request_kind
        CHECK (request_kind IN ('SINGLE', 'MASS')),
    CONSTRAINT chk_mat_rework_email_send_status
        CHECK (send_status IN ('SENT', 'FAILED'))
);

-- Both read paths (thread API, inbound subject-token match) filter on the
-- request the mail belongs to.
CREATE INDEX IF NOT EXISTS idx_mat_rework_email_request
    ON public.mat_rework_email (request_kind, request_id);

COMMENT ON TABLE public.mat_rework_email IS
    'One row per rework notification mail sent to a hand-picked new approver (chain replacement with notifyVia=EMAIL).';
COMMENT ON COLUMN public.mat_rework_email.request_kind IS
    'Which request table request_id points at: SINGLE (mat_single_request) or MASS (mat_mass_request).';
COMMENT ON COLUMN public.mat_rework_email.request_id IS
    'mat_single_request.id or mat_mass_request.id — no FK, because one column cannot reference two tables.';
COMMENT ON COLUMN public.mat_rework_email.message_id IS
    'RFC 5322 Message-ID returned by the SMTP server; the key inbound replies thread on. NULL when the send failed.';
COMMENT ON COLUMN public.mat_rework_email.subject IS
    'Subject as sent, including the [VMS#<request_no>] thread token appended when the editor removed it.';
COMMENT ON COLUMN public.mat_rework_email.body IS
    'Plain-text body as sent (Master Data may edit the generated template before sending).';
COMMENT ON COLUMN public.mat_rework_email.to_email IS
    'mst_user.email of the picked approver at send time; also the address a reply must come from to count as his.';
COMMENT ON COLUMN public.mat_rework_email.to_user_id IS
    'mst_user.user_id of the picked approver (no FK: the row must survive a user being removed).';
COMMENT ON COLUMN public.mat_rework_email.sent_by_user_id IS
    'mst_user.user_id of the Master Data actor who triggered the rework.';
COMMENT ON COLUMN public.mat_rework_email.send_status IS
    'SENT (SMTP accepted it) or FAILED (see send_error). A FAILED send never fails the rework itself.';
COMMENT ON COLUMN public.mat_rework_email.send_error IS
    'SMTP/transport error message when send_status = FAILED.';

CREATE TABLE IF NOT EXISTS public.mat_rework_email_reply (
    id bigserial PRIMARY KEY,
    rework_email_id bigint NOT NULL,
    from_email varchar(255) NOT NULL,
    sender_matches boolean NOT NULL DEFAULT false,
    message_id text NULL,
    received_at timestamptz NULL,
    body_text text NOT NULL,
    body_full text NULL,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_mat_rework_email_reply_message_id UNIQUE (message_id),
    CONSTRAINT fk_mat_rework_email_reply_email FOREIGN KEY (rework_email_id)
        REFERENCES public.mat_rework_email(id) ON DELETE CASCADE
);

-- The thread API loads every reply of a mail in one go.
CREATE INDEX IF NOT EXISTS idx_mat_rework_email_reply_email
    ON public.mat_rework_email_reply (rework_email_id);

COMMENT ON TABLE public.mat_rework_email_reply IS
    'Inbound replies to a mat_rework_email row, pulled off IMAP by reworkEmailInboundService. Read-only in the UI.';
COMMENT ON COLUMN public.mat_rework_email_reply.from_email IS
    'Envelope/header From address of the reply, lower-cased for comparison.';
COMMENT ON COLUMN public.mat_rework_email_reply.sender_matches IS
    'false when the reply did NOT come from mat_rework_email.to_email (forwarded, delegated, or spoofed) — surfaced as a warning chip.';
COMMENT ON COLUMN public.mat_rework_email_reply.message_id IS
    'Message-ID of the reply; UNIQUE so re-polling the same UID range can never duplicate a reply.';
COMMENT ON COLUMN public.mat_rework_email_reply.received_at IS
    'Envelope date of the reply as the sending client stamped it; NULL when the header was missing/unparseable.';
COMMENT ON COLUMN public.mat_rework_email_reply.body_text IS
    'Reply text with the quoted tail stripped (stripQuotedReply) — what the UI shows.';
COMMENT ON COLUMN public.mat_rework_email_reply.body_full IS
    'Untouched parsed text of the reply, kept so a bad strip heuristic never loses content.';

CREATE TABLE IF NOT EXISTS public.mat_email_poll_cursor (
    mailbox varchar(100) PRIMARY KEY,
    uidvalidity bigint NOT NULL,
    last_uid bigint NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.mat_email_poll_cursor IS
    'Per-mailbox IMAP poll cursor. Seeded at uidNext-1 on first run so the ~14k message history in the VMS box is never scanned.';
COMMENT ON COLUMN public.mat_email_poll_cursor.uidvalidity IS
    'IMAP UIDVALIDITY of the mailbox; when the server changes it every stored UID is meaningless and the cursor is re-seeded at uidNext-1.';
COMMENT ON COLUMN public.mat_email_poll_cursor.last_uid IS
    'Highest UID already looked at. Advanced on EVERY polled message, matched or not, so an unmatched mail is examined once and never again.';

COMMIT;
