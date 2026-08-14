# apps/defi: the admin propose-change dialog could lock up, and would not let you clear a field

The admin console's "propose a change" dialog pre-fills the new-value box with
the setting's current on-chain value, so an operator adjusting a number starts
from where it is today. Two faults in how that pre-fill was built.

**It could freeze the dialog.** The pre-fill was written as a calculation that
quietly wrote its own answer back into the form, and the same form value was one
of the inputs the calculation watched. The only thing that stopped it repeating
forever was that the value it wrote was normally non-empty, which made a "has
anything been typed yet" check fail on the next pass. For a setting whose
current value is blank, the pre-fill wrote a blank, that check kept passing, and
the dialog re-drew itself until the browser gave up. Nothing about the settings
catalogue prevents a blank current value — this was luck, not design.

**It would not let you empty the box.** Because "has anything been typed yet"
was inferred from whether the box was empty, deleting the pre-filled number was
indistinguishable from never having touched it, so the dialog immediately put
the old value back. An operator could overwrite the value but could not clear
it.

The pre-fill is now worked out from the current value each time the dialog
draws, rather than being written into the form, and whether the operator has
edited anything is tracked in its own right. Both faults go away: there is no
value being fed back into its own calculation, and clearing the box now clears
it. A field the operator has not touched also picks up a fresher current value
if one arrives while the dialog is open, which it previously would not have.

Unchanged: settings whose setter takes more than one value still start out
empty, so each one is entered deliberately — proposing the same value as today
is allowed, but it has to be typed.

**And a third fault, which only became reachable once clearing worked.** Eight
of the settings in this console are on/off switches for live protocol mechanics
— range orders, partial fills, periodic interest, the numeraire swap, and the
three automation switches. The dialog's "you must fill every box" check
deliberately skipped on/off settings, and the code that turns typed text into a
value for the contract treated anything it did not recognise — including an
empty box — as "off".

While the box refused to stay empty, that combination could not be reached. With
clearing fixed, it could: clear the box on an enabled switch, press the button,
and the dialog would produce a perfectly valid, signable proposal that turns
that mechanic **off** — looking no different from one an operator meant to
write. The dialog now requires an on/off setting to say exactly "true" or
"false" and says so if it doesn't, and the encoder refuses an unrecognised value
outright rather than quietly choosing "off" for you. Turning a switch off is of
course still allowed; it just has to be asked for.

Nine tests now cover this dialog, which had none. Run against the previous
version, four of them fail — one with React's own "too many re-renders" guard,
which is the freeze reproduced directly, and two on the blank on/off switch.
