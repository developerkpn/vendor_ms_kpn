# Upload persistence (ECS Fargate + EFS)

> **Status, 2026-09-18.** The dev task definition `apps-vendor-management-dev`
> carries an EFS volume `vmc_file_attachment` (`vms-ecs-efs`,
> `fs-0aa9d996c4b791b13`, root `/`, no access point) mounted read-write into
> container `apps-vendor-dev` at `/app/backend/public`, **and has done all along**.
>
> **Uploads therefore do persist across redeploys, and the blank-attachment bug is
> NOT caused by a missing volume.** An earlier version of this file said it was.
> That conclusion was drawn from counting files baked into the image, which the
> mount hides at runtime, so it measured the wrong thing. The cause is still open;
> see "What is still unexplained".
>
> **Closed 2026-09-18** at the owner's call, without reproducing the reported
> blank attachments. Persistence was ruled out; nothing else was tested. Two items
> below were confirmed and remain open on their own merits: the masked image files
> and the shared dev/prod file system.

## What the mount does explain

Anything the image ships under `/app/backend/public` is invisible at runtime,
because the volume is mounted over it. That is about sixty files: 51 older
request attachments and eight loose files that older `mat_attachment` rows
reference by bare filename. Every database row pointing at one of those renders
blank and always will, unless the files are copied onto the volume.

It does not explain an attachment uploaded through the deployed app, which lands
on the volume and should stay there.

## What is still unexplained

Attachments uploaded to the running dev environment, including the September mass
requests made with the shared-file toggle, are on the volume by this reasoning and
should load. If they do not, the cause is downstream of persistence. The next step
is to separate the two cases by testing a **fresh** upload:

1. Upload an attachment now and open it immediately. If it fails, writing or
   serving is broken and persistence is irrelevant.
2. If it loads, redeploy and open it again. If it fails only then, the volume is
   not being used the way the task definition says.
3. If it survives both, the blank ones are older rows whose files were never on
   the volume, and the fix is data cleanup plus the seeding below.

A direct read of the file system, or an HTTP probe of a known
`/api/material/file/<path>` against the dev host, would settle this faster than
any of the above. Not done — the investigation was closed first. If approvers
report blank attachments again, start here rather than re-deriving it.

## What to mount, and where

Everything the application writes lands under one directory:

```
/app/backend/public
```

Verified against the image:

- `WORKDIR` is `/app`, and request attachments resolve their directory from the
  process working directory (`path.resolve() + /backend/public`), so this is the
  real path at runtime.
- Guides resolve the same directory from `__dirname` instead, and land on
  `/app/backend/public/guides`. One mount covers both.
- The built frontend is **not** in this tree. It sits at `/app/public/build`, a
  different directory, so mounting here does not hide the SPA.

Mount the whole directory rather than only `attachments/` and `guides/`. Material
master uploads still write files flat into the root of it, so a narrower mount
would leave that one path ephemeral.

## One-time seeding

The image ships about sixty files in this directory: the 51 older attachments and
a handful of loose material master files that older `mat_attachment` rows point
at by bare filename. An empty EFS mounted over the top hides them.

Copy the image's current contents onto the EFS volume once, before or on first
mount. From a machine with the image and the file system mounted:

```bash
cid=$(docker create 862989604357.dkr.ecr.ap-southeast-1.amazonaws.com/bwbimdm/vms:dev-0.1.0)
docker cp "$cid:/app/backend/public/." /mnt/efs-vms-uploads/
docker rm "$cid"
```

## AWS setup (for an environment that does not have this yet)

1. **Create an EFS file system** in the same VPC as the ECS service, with mount
   targets in every subnet the tasks run in.
2. **Create an access point** so the task does not run as root on the share:
   - Root directory: `/vms-uploads`
   - Owner UID/GID: `1000` (the `node` user in `node:20-alpine`)
   - Permissions: `0755`
3. **Security groups**: allow inbound NFS (TCP 2049) on the EFS mount target's
   security group from the ECS service's security group.
4. **Task execution role** needs `elasticfilesystem:ClientMount`,
   `ClientWrite` and `ClientRootAccess` on the file system, or attach
   `AmazonElasticFileSystemClientReadWriteAccess` scoped to it.

## Task definition

Add a `volumes` entry and a `mountPoints` entry on the container. Everything else
in the task definition stays as it is.

```json
{
  "volumes": [
    {
      "name": "vms-uploads",
      "efsVolumeConfiguration": {
        "fileSystemId": "fs-REPLACE_ME",
        "transitEncryption": "ENABLED",
        "authorizationConfig": {
          "accessPointId": "fsap-REPLACE_ME",
          "iam": "ENABLED"
        }
      }
    }
  ],
  "containerDefinitions": [
    {
      "name": "REPLACE_WITH_CONTAINER_NAME",
      "mountPoints": [
        {
          "sourceVolume": "vms-uploads",
          "containerPath": "/app/backend/public",
          "readOnly": false
        }
      ]
    }
  ]
}
```

Register the new revision and update the service.

## Verifying it worked

1. Upload an attachment through the UI and confirm it opens.
2. Force a new deployment of the service without changing the image.
3. Open the same attachment again. It should still load.

Before this change, step 3 was the moment the file disappeared.

## Related, not fixed here

- `backend/public/assets/` does not exist in the image, so the rework email
  template's logo (`/static/assets/kpn-logo-2.png`, referenced by
  `backend/helper/EmailGenv2.js`) is already a broken link. Seeding the volume is
  a good moment to add it.
- The 256 existing rows include many whose files are already gone for good. They
  will render as missing until someone clears or re-uploads them. A query listing
  rows whose `file_path` has no file on the volume would identify them once the
  volume exists.


## Open questions on the existing dev mount


**2. Dev and prod appear to share one file system.** Prod reportedly uses the same
`fs-0aa9d996c4b791b13` with a different container. The dev volume has root
directory `/` and **no access point**, so dev's container sees the whole file
system rather than a subtree of it. If prod is also rooted at `/`, the two
environments read and write the same directory:

- Vendor documents are stored flat by filename, so the dev app can serve prod
  vendor documents: tax certificates, bank passbooks, signed declarations.
- A dev upload can overwrite a prod file if the two filenames ever coincide.

If that is the case, give each environment its own EFS **access point** with a
distinct root directory (`/dev` and `/prod`), and point each task definition at
its own. The container path stays `/app/backend/public` either way, so no
application change is involved.

**3. The image's own files are masked.** About sixty files ship inside the image
under this path: the 51 older attachments and eight loose material master files
that older `mat_attachment` rows reference by bare filename. A volume mounted over
the directory hides all of them, whatever the volume contains. They need copying
onto the file system once, as described under "One-time seeding".
