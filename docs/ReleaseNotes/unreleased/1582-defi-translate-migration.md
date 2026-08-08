### The lending app's translation command now goes through the checked path

There were two translation programs in the repository doing the same job. One
had been improved steadily — it refuses a translation that invents or drops a
value placeholder, refuses a key the English source does not have, refuses an
empty string (which renders blank rather than falling back to English), refuses
a reply that came back short of what was asked for, can fill in only the
missing lines instead of rewriting a whole file, and writes in a way that
cannot leave a half-written file behind if it fails. The other was the original
it had been generalised from, and had learned none of that. The lending app
still used the original.

They had also drifted apart in what they protect. The older copy still guarded
the names of two contracts that were removed from the platform months ago,
while missing the word the recovery screen asks the user to type — a word that,
if it were ever translated, would leave the confirm button permanently
disabled for speakers of that language, because they would type what the page
asked for and it would never match.

The lending app now uses the shared program, and the duplicate is gone. Its
glossary and locale list come from the one shared definition, so a lesson
learned in one place is learned everywhere. The list of which languages the
lending app actually ships stays with the app, because that genuinely differs
between the app and the marketing site.

Nothing about which languages get translated changes: both programs already
defaulted to the same thing — languages that have no file yet — so this is a
change of which checks run, not of what work gets done.
