## Thread — Sanctions services run when started through their release link (PR #2586)

The first install of the two sanctions services on the keeper machine found that neither would have done any work. The machine starts each service through a link to the installed release, and each script checked whether it was the program being run by comparing two paths as written: one through the link, one to the link's target. They never matched, so every run skipped its work, exited cleanly and reported success, with no alert and nothing in the failed-units list. The services and the offline diff tool now share one check that compares the real files on both sides. No run had sent anything, and no timer had been enabled.

The installer also left each new release folder readable only by root, so the services' own user could not load anything from it; it now opens the folder. Its pre-switch check used to run as root from the real folder, which is why it caught neither problem. It now runs each service's check the way the machine runs that service, as a throwaway user, with an empty environment, through a link and without network, and requires the check's success line. A release with either problem stops the install before it becomes current. The runbook now also says that a run which writes no report has failed, whatever the service manager says.

Refs #2443.
