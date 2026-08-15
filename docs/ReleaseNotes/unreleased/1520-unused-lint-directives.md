# Six dead lint suppressions removed from the live UX sweep

The committed live-UX sweep driver carried six suppression comments for a lint rule
that is not switched on for it, so each one was reported as dead on every lint run.
Removing them takes the app's lint output down to only the genuine remaining
warnings, with no change to what the sweep does or prints.
