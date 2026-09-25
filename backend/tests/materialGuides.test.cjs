const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const GuideService = require("../services/guideService");

// Material guides (migration 20260918_mat_guide.sql).
//
// Offline throughout: these cover the parts that decide where bytes land, what
// the dashboard is told, and what a hostile filename can reach — none of which
// need a database or a socket.

test("a stored name keeps the extension but nothing else from the upload", () => {
    const stored = GuideService.buildStoredName("Panduan Material (rev 2).mp4");

    assert.match(stored, /\.mp4$/);
    assert.equal(stored.includes("Panduan"), false);
    assert.equal(stored.includes(" "), false);
    assert.equal(stored.includes("("), false);
});

test("two uploads of the same filename never collide", () => {
    const names = new Set(
        Array.from({ length: 50 }, () => GuideService.buildStoredName("guide.pdf"))
    );

    assert.equal(names.size, 50);
});

test("an extensionless upload still gets a usable stored name", () => {
    const stored = GuideService.buildStoredName("README");

    assert.notEqual(stored, "");
    assert.equal(stored.includes("."), false);
});

test("a stored name resolves inside the guide directory", () => {
    const resolved = GuideService.resolveStoredPath("abc-123.mp4");

    assert.equal(path.dirname(resolved), path.resolve(GuideService.GUIDE_DIR));
});

test("a traversing stored name is refused rather than resolved", () => {
    // stored_name is generated, never user input — but a hand-edited or
    // tampered row must not be able to read or unlink files elsewhere.
    for (const attempt of [
        "../../../etc/passwd",
        "..",
        "../secrets.env",
        "nested/../../escape.mp4",
    ]) {
        assert.throws(
            () => GuideService.resolveStoredPath(attempt),
            error => error.statusCode === 400 && error.code === "GUIDE_INVALID_PATH",
            `expected ${attempt} to be refused`
        );
    }
});

test("an absolute stored name cannot redirect the read out of the directory", () => {
    assert.throws(
        () => GuideService.resolveStoredPath("/etc/passwd"),
        error => error.code === "GUIDE_INVALID_PATH"
    );
});

test("the per-file ceiling is 100MB and one batch is capped at 1GB", () => {
    assert.equal(GuideService.MAX_FILE_SIZE_BYTES, 100 * 1024 * 1024);

    // A batch cap below files x per-file size is the point: 20 x 100MB would
    // outlast Node's request timeout and be killed mid-upload.
    assert.equal(GuideService.MAX_TOTAL_UPLOAD_BYTES, 1024 * 1024 * 1024);
    assert.ok(
        GuideService.MAX_TOTAL_UPLOAD_BYTES <
            GuideService.MAX_FILE_SIZE_BYTES * GuideService.MAX_FILES_PER_UPLOAD
    );
});

test("uploads are staged on the destination filesystem, outside the served tree", () => {
    const tmpDir = path.resolve(GuideService.GUIDE_TMP_DIR);
    const guideDir = path.resolve(GuideService.GUIDE_DIR);
    const publicDir = path.resolve(path.join(guideDir, ".."));

    // Not os.tmpdir(): on a host where /tmp is tmpfs that would put a 100MB
    // video in RAM and turn the move into a full copy across devices.
    assert.notEqual(tmpDir, path.resolve(require("node:os").tmpdir()));

    // Not under backend/public, which express.static serves: a half-written
    // upload must not be reachable over HTTP.
    assert.equal(tmpDir.startsWith(publicDir + path.sep), false);

    // Same filesystem as the destination, so the move is a rename rather than a
    // read-and-write copy. Both directories are created here for the same reason
    // the service creates them on upload: they may not exist yet.
    const nodeFs = require("node:fs");
    nodeFs.mkdirSync(tmpDir, { recursive: true });
    nodeFs.mkdirSync(guideDir, { recursive: true });
    assert.equal(nodeFs.statSync(tmpDir).dev, nodeFs.statSync(guideDir).dev);
});

test("video and document extensions are both accepted, executables are not", () => {
    for (const allowed of ["mp4", "webm", "mov", "pdf", "docx", "pptx", "png"]) {
        assert.equal(GuideService.ALLOWED_EXTENSIONS.has(allowed), true, allowed);
    }
    for (const blocked of ["exe", "sh", "js", "php", "bat", "html"]) {
        assert.equal(GuideService.ALLOWED_EXTENSIONS.has(blocked), false, blocked);
    }
});

test("per-file metadata is optional and survives being absent or empty", () => {
    assert.deepEqual(GuideService.parseMeta(undefined), []);
    assert.deepEqual(GuideService.parseMeta([""]), []);
    assert.deepEqual(GuideService.parseMeta(['[{"name":"Intro"}]']), [{ name: "Intro" }]);
});

test("malformed metadata is a 400, not a crash", () => {
    for (const bad of ["not json", '{"name":"x"}']) {
        assert.throws(
            () => GuideService.parseMeta([bad]),
            error => error.statusCode === 400 && error.code === "GUIDE_INVALID_META",
            `expected ${bad} to be refused`
        );
    }
});

test("the content path points at the range-capable endpoint, not the static mount", () => {
    const contentPath = GuideService.guideContentPath(42);

    assert.equal(contentPath, "/material/guides/files/42/content");
    assert.equal(contentPath.includes("/static/"), false);
});

// ---------------------------------------------------------------------------
// getGuideTree: the shape the dashboard renders.
// GuideModel is stubbed so no database is touched.

const withStubbedModel = async ({ folders, files }, assertion) => {
    const GuideModel = require("../models/GuideModel");
    const originalFolders = GuideModel.listFolders;
    const originalFiles = GuideModel.listFiles;

    GuideModel.listFolders = async () => folders;
    GuideModel.listFiles = async () => files;

    try {
        await assertion(await GuideService.getGuideTree());
    } finally {
        GuideModel.listFolders = originalFolders;
        GuideModel.listFiles = originalFiles;
    }
};

const file = overrides => ({
    id: 1,
    folderId: null,
    name: null,
    description: null,
    originalName: "guide.pdf",
    storedName: "stored-1.pdf",
    mimeType: "application/pdf",
    sizeBytes: "2048",
    createdBy: "u1",
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    ...overrides,
});

test("guides in a folder are grouped under it and standalone guides stay separate", async () => {
    await withStubbedModel(
        {
            folders: [{ id: 7, name: "Videos", description: null }],
            files: [
                file({ id: 1, folderId: 7, originalName: "intro.mp4" }),
                file({ id: 2, folderId: 7, originalName: "advanced.mp4" }),
                file({ id: 3, folderId: null, originalName: "cheatsheet.pdf" }),
            ],
        },
        tree => {
            assert.equal(tree.folders.length, 1);
            assert.deepEqual(
                tree.folders[0].files.map(item => item.originalName),
                ["intro.mp4", "advanced.mp4"]
            );
            assert.deepEqual(
                tree.files.map(item => item.originalName),
                ["cheatsheet.pdf"]
            );
        }
    );
});

test("a guide naming a folder that no longer exists is listed standalone, not dropped", async () => {
    await withStubbedModel(
        { folders: [], files: [file({ id: 4, folderId: 999 })] },
        tree => {
            assert.deepEqual(tree.folders, []);
            assert.equal(tree.files.length, 1);
            assert.equal(tree.files[0].id, 4);
        }
    );
});

test("an empty folder is still listed, so it can be filled", async () => {
    await withStubbedModel(
        { folders: [{ id: 2, name: "Empty", description: null }], files: [] },
        tree => {
            assert.equal(tree.folders.length, 1);
            assert.deepEqual(tree.folders[0].files, []);
        }
    );
});

test("the display name falls back to the original filename when none was given", async () => {
    await withStubbedModel(
        {
            folders: [],
            files: [
                file({ id: 5, name: null, originalName: "unnamed.pdf" }),
                file({ id: 6, name: "Nice Title", originalName: "raw-name.pdf" }),
            ],
        },
        tree => {
            assert.equal(tree.files[0].displayName, "unnamed.pdf");
            assert.equal(tree.files[1].displayName, "Nice Title");
        }
    );
});

test("size comes back as a number, not the string pg returns for bigint", async () => {
    await withStubbedModel(
        { folders: [], files: [file({ sizeBytes: "104857600" })] },
        tree => {
            assert.equal(tree.files[0].sizeBytes, 104857600);
            assert.equal(typeof tree.files[0].sizeBytes, "number");
        }
    );
});

// ---------------------------------------------------------------------------
// The upload path itself, end to end through formidable and onto disk.
// Only GuideModel is stubbed; the multipart parse and the file move are real.

const fs = require("node:fs");
const { Readable } = require("node:stream");

const buildMultipartRequest = parts => {
    const boundary = `----guidetest${Date.now()}${Math.random().toString(16).slice(2)}`;
    const chunks = [];

    for (const part of parts) {
        if (part.filename) {
            chunks.push(
                Buffer.from(
                    `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; ` +
                        `filename="${part.filename}"\r\nContent-Type: ${part.contentType}\r\n\r\n`
                )
            );
            chunks.push(part.data);
            chunks.push(Buffer.from("\r\n"));
        } else {
            chunks.push(
                Buffer.from(
                    `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`
                )
            );
        }
    }

    chunks.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(chunks);
    const request = Readable.from([body]);
    request.headers = {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(body.length),
    };
    return request;
};

const withStubbedWrites = async assertion => {
    const GuideModel = require("../models/GuideModel");
    const originalInsert = GuideModel.insertFiles;
    const originalGetFolder = GuideModel.getFolderById;
    const captured = [];

    GuideModel.insertFiles = async rows => {
        captured.push(...rows);
        return rows.map((row, index) => ({ ...row, id: index + 1 }));
    };
    GuideModel.getFolderById = async id => ({ id, name: "Stub folder" });

    try {
        await assertion(captured);
    } finally {
        GuideModel.insertFiles = originalInsert;
        GuideModel.getFolderById = originalGetFolder;
        for (const row of captured) {
            try {
                fs.unlinkSync(GuideService.resolveStoredPath(row.storedName));
            } catch (error) {
                if (error.code !== "ENOENT") {
                    throw error;
                }
            }
        }
    }
};

test("a bulk upload lands every file on disk with its metadata attached", async () => {
    await withStubbedWrites(async captured => {
        const first = Buffer.from("first guide contents");
        const second = Buffer.alloc(4096, 7);

        const request = buildMultipartRequest([
            { name: "folderId", value: "3" },
            {
                name: "meta",
                value: JSON.stringify([
                    { name: "Intro video", description: "Start here" },
                    { name: "", description: "" },
                ]),
            },
            { name: "files", filename: "intro.mp4", contentType: "video/mp4", data: first },
            { name: "files", filename: "manual.pdf", contentType: "application/pdf", data: second },
        ]);

        const rows = await GuideService.uploadGuides(request, { createdBy: "u-1" });

        assert.equal(rows.length, 2);
        assert.equal(captured.length, 2);

        // Metadata is matched to files by position. A blank description stays
        // null; a blank name falls back to the filename, because the column is
        // NOT NULL and the dashboard needs something to label the guide with.
        assert.equal(captured[0].name, "Intro video");
        assert.equal(captured[0].description, "Start here");
        assert.equal(captured[1].name, "manual.pdf");
        assert.equal(captured[1].description, null);

        assert.equal(captured[0].originalName, "intro.mp4");
        assert.equal(captured[0].mimeType, "video/mp4");
        assert.equal(captured[0].folderId, 3);
        assert.equal(captured[0].createdBy, "u-1");

        // The bytes really arrived, at the right size.
        const firstPath = GuideService.resolveStoredPath(captured[0].storedName);
        const secondPath = GuideService.resolveStoredPath(captured[1].storedName);
        assert.equal(fs.readFileSync(firstPath).equals(first), true);
        assert.equal(fs.statSync(secondPath).size, 4096);
        assert.equal(captured[1].sizeBytes, 4096);
    });
});

test("a guide with no name given falls back to its filename rather than failing", async () => {
    // The name column is NOT NULL and the uploader prefills it, so a client that
    // sends nothing is a client bug — not a reason to throw away a 100MB upload
    // that has already finished streaming.
    await withStubbedWrites(async captured => {
        const request = buildMultipartRequest([
            { name: "meta", value: JSON.stringify([{ name: "   ", description: "" }]) },
            { name: "files", filename: "unnamed.pdf", contentType: "application/pdf", data: Buffer.from("x") },
        ]);

        await GuideService.uploadGuides(request, { createdBy: "u-name" });

        assert.equal(captured.length, 1);
        assert.equal(captured[0].name, "unnamed.pdf");
        assert.equal(captured[0].description, null);
    });
});

test("a given name is kept and the description may still be empty", async () => {
    await withStubbedWrites(async captured => {
        const request = buildMultipartRequest([
            { name: "meta", value: JSON.stringify([{ name: "Intro video", description: "" }]) },
            { name: "files", filename: "raw.mp4", contentType: "video/mp4", data: Buffer.from("x") },
        ]);

        await GuideService.uploadGuides(request, { createdBy: "u-name2" });

        assert.equal(captured[0].name, "Intro video");
        assert.equal(captured[0].description, null);
    });
});

test("renaming a guide to nothing is refused", async () => {
    await assert.rejects(
        () => GuideService.updateFile(1, { name: "   " }),
        error => error.statusCode === 400 && error.code === "GUIDE_NAME_REQUIRED"
    );
});

test("an upload with no folder stores standalone guides", async () => {
    await withStubbedWrites(async captured => {
        const request = buildMultipartRequest([
            { name: "files", filename: "loose.pdf", contentType: "application/pdf", data: Buffer.from("x") },
        ]);

        await GuideService.uploadGuides(request, { createdBy: "u-2" });

        assert.equal(captured.length, 1);
        assert.equal(captured[0].folderId, null);
    });
});

test("a disallowed file type is refused and leaves nothing on disk", async () => {
    await withStubbedWrites(async captured => {
        const request = buildMultipartRequest([
            { name: "files", filename: "payload.exe", contentType: "application/octet-stream", data: Buffer.from("MZ") },
        ]);

        await assert.rejects(
            () => GuideService.uploadGuides(request, { createdBy: "u-3" }),
            error => error.statusCode === 400 && error.code === "GUIDE_FILE_TYPE"
        );

        assert.equal(captured.length, 0);
    });
});

test("a rejected upload strands no part-file in the staging directory", async () => {
    // The parser writes each file in full before anything is validated, so a
    // rejection after the parse would otherwise leave a full-size file on disk
    // until the sweep. Every rejection path is checked, not just the first.
    const stagedCount = () => {
        try {
            return fs.readdirSync(GuideService.GUIDE_TMP_DIR).length;
        } catch (error) {
            return error.code === "ENOENT" ? 0 : -1;
        }
    };

    const rejections = [
        {
            name: "wrong type",
            parts: [
                { name: "files", filename: "payload.exe", contentType: "application/octet-stream", data: Buffer.from("MZ") },
            ],
            code: "GUIDE_FILE_TYPE",
        },
        {
            name: "unknown folder",
            parts: [
                { name: "folderId", value: "4242" },
                { name: "files", filename: "ok.pdf", contentType: "application/pdf", data: Buffer.from("hello") },
            ],
            code: "GUIDE_FOLDER_NOT_FOUND",
        },
        {
            name: "malformed metadata",
            parts: [
                { name: "meta", value: "not json" },
                { name: "files", filename: "ok.pdf", contentType: "application/pdf", data: Buffer.from("hello") },
            ],
            code: "GUIDE_INVALID_META",
        },
    ];

    for (const rejection of rejections) {
        const GuideModel = require("../models/GuideModel");
        const originalGetFolder = GuideModel.getFolderById;
        // Only the folder case needs a miss; the others must not depend on it.
        GuideModel.getFolderById = async () => null;

        const before = stagedCount();
        try {
            await assert.rejects(
                () =>
                    GuideService.uploadGuides(buildMultipartRequest(rejection.parts), {
                        createdBy: "u-reject",
                    }),
                error => error.code === rejection.code,
                rejection.name
            );
        } finally {
            GuideModel.getFolderById = originalGetFolder;
        }

        assert.equal(stagedCount(), before, `${rejection.name} left a part-file behind`);
    }
});

test("an upload carrying no file at all is a 400, not an empty success", async () => {
    await withStubbedWrites(async () => {
        const request = buildMultipartRequest([{ name: "folderId", value: "" }]);

        await assert.rejects(
            () => GuideService.uploadGuides(request, { createdBy: "u-4" }),
            error => error.statusCode === 400 && error.code === "GUIDE_NO_FILES"
        );
    });
});

test("a traversing upload filename cannot escape the guide directory", async () => {
    await withStubbedWrites(async captured => {
        const request = buildMultipartRequest([
            {
                name: "files",
                filename: "../../../../evil.pdf",
                contentType: "application/pdf",
                data: Buffer.from("nope"),
            },
        ]);

        await GuideService.uploadGuides(request, { createdBy: "u-5" });

        assert.equal(captured.length, 1);
        assert.equal(captured[0].storedName.includes(".."), false);
        assert.equal(captured[0].storedName.includes("/"), false);

        const stored = GuideService.resolveStoredPath(captured[0].storedName);
        assert.equal(stored.startsWith(require("node:path").resolve(GuideService.GUIDE_DIR)), true);
        assert.equal(fs.existsSync(stored), true);
    });
});
