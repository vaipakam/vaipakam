# Recovery: switching wallet or network no longer flashes the old form

When the connected wallet or network changed, the recovery page cleared the form
and restored any saved in-progress recovery for the new identity one beat after
the change, so a frame could show the previous identity's form contents.

Both now happen in the same update as the change itself. A saved recovery for the
new identity still appears exactly as before, and still appears on a fresh page
load; the difference is that the previous identity's values are never shown
alongside the new identity.

The safeguard that disowns an in-flight submission when the identity changes now
takes effect as part of that same update, so there is no longer any window in
which the form has been cleared for a new identity while a submission belonging
to the previous one is still considered current.
