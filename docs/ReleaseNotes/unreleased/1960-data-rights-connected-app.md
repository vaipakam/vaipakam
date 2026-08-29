## Connected app — you can take your data with you, or remove it

The connected app now has a Data Rights page: one button to download
everything it keeps in your browser, another to erase it. Reachable from
Settings, under "Your data".

This is a control being put back rather than a new idea. The old
connected app had one, and it went out with that app. The main
vaipakam.com site still has its own version, which is easy to mistake
for covering this — it does not, and cannot. A browser keeps each site's
data in its own compartment, so the buttons on one site genuinely have
no way to read or clear what another site stored. Two sites, two sets of
data, two pages. There was no way around that; the page had to be built
here.

**The download** is a single file you can keep or read: display
preferences, alert settings, which notifications you have already seen,
and markers for anything you started and did not finish. It is written
in plain JSON, so it is readable without any special tool.

**The erase** removes the same set from the device you are on. The page
tells you how many items are stored before you confirm, and how many
were removed afterwards — not just "done". That distinction matters more
than it sounds: some browsers, particularly private windows and
locked-down privacy settings, refuse to let a site clear its own
storage. Reporting that as success would be a false assurance about a
legal right, so a refusal says so plainly and points at the browser's
own settings, which do work. A download taken while part of the storage
refuses to be read carries the warning inside the file itself, naming
what is missing — the file travels away from the page, so the page's
warning travels with it.

Just as important is what the page says it **cannot** do, stated as
prominently as what it can:

- **Anything on the blockchain.** Every transaction you have signed is
  public and permanent. Nobody can erase them, this protocol included,
  and a page implying otherwise would be misleading about the one thing
  people most want to hear. Your wallet address is the one exception the
  page names: where you saved per-wallet settings it is part of what
  this browser stores — and so part of the download, which says so
  itself, so the file can be judged before it is shared. Erasing removes
  those local copies; nothing on the chain changes.
- **Alerts.** If you linked Telegram, that link is held by the alerts
  service, not your browser. Unlinking in Settings is what removes it.
- **The main site's own data**, which has its own controls there.
- **Error reports held by support**, which are removed on request by
  email.

Your language and theme are shared with the main site through a
preference both sites can read, so erasing here resets them there too.
That is said on the page rather than left as a surprise.

One deliberate choice worth naming: the page does not reload after
erasing. The old version did, which meant the confirmation vanished
before anyone could read it — you were returned to a blank-slate page
with no word of what had happened, on the one screen where being told
what happened is the entire point.

Accepting the Terms of Service is never required to reach any of this.
A right you can be locked out of until you accept a legal document is
not a right, so this page stays open whatever the terms say.
