# Host log shipping (2026-11-18)

Not a one-way deploy, and no ordering constraint.

- **What the apply changes:** two lifecycle rules on the cell's bucket (`expire-logs`, `expire-log-delete-markers`); a new version of both launch templates (their user data carries `install.sh`); the Image Builder component and recipe (their version is `install.sh`'s hash). No AMI build starts unless the release's binaries changed. Unverified until the first apply: that S3 accepts two expiration rules on the one prefix.
- **Hosts:** the script travels in user data, and `install.sh` rewrites the units at every boot, so a host launched after the apply ships its logs whatever AMI it boots. A host already running never does; it is replaced as hosts come and go.
- **Rollback (a forward revert):** hosts launched after it ship nothing; the `logs/` objects already there stay until someone deletes them, since the revert removes their expiry rules too. Delete the prefix by hand then.
