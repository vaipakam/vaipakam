## Keeper machine: the keeper's memory is protected from the rest of the machine (#2651 follow-up)

The keeper machine has about 1 GB of memory. Readings taken after #2691
showed the kernel pushing the keeper itself into swap: 112 MiB of it at one
point, rising by about 70 MiB in a minute. Every swapped page a tick touches
has to be read back from disk while that tick waits.

The keeper now runs in a slice of its own with a memory protection of 320 MiB.
That figure is its measured footprint, about 140 MiB resident plus 110 MiB
swapped, with room to grow. Up to that amount, the kernel reclaims the
keeper's memory only once there is nothing unprotected left to reclaim, so a
build, an updater run or anything else on the machine is swapped out first.
The protection reserves nothing: memory the keeper is not using stays
available to everything else. If the machine still runs out of memory, the
kernel's out-of-memory killer now picks a build before the keeper, and the
next deploy run retries the build.

Two things are stated rather than implied:

- **The build gets no memory cap.** A cap would have to be sized from the
  build's peak memory. systemd's logged peak for the build unit reads 256K to
  1.8M for builds that use nearly two CPU-minutes, which is not a real figure.
  Protecting the keeper does not depend on knowing the build's size.
- **The low disk priority #2691 gave the build has no effect on this
  machine.** Its disk scheduler is `none`, which ignores I/O priority. The
  setting is kept for hosts whose scheduler honours it, and the runbook now
  says so. The low CPU priority does take effect.

The deploy updater now also re-installs the running release's units whenever
any installed unit or script differs from that release's. That is how the new
slice reaches the machine at the run after this change deploys, instead of
waiting for the next build.
