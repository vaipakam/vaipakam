# The phone "More" sheet closes as you navigate, not a frame later

Tapping a link inside the phone More sheet previously left the sheet on screen for
the first frame of the page it had navigated to, with the More tab still shown as
the active one. The sheet now closes in the same update as the navigation, so the
new page's first frame is the new page.

Nothing about when the sheet opens or what it contains has changed.
