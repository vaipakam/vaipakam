# The phone "More" sheet closes as you navigate away from it

If the phone More sheet was open and you navigated without tapping one of its
links — using the browser's back or forward gesture, or following a link elsewhere
in the app that moves you programmatically — the sheet stayed on screen over the
first frame of the page you arrived at. It now closes in the same update as the
navigation.

Tapping a link inside the sheet was already unaffected: those links close the
sheet as they are tapped.

Nothing about when the sheet opens, what it contains, or which tab is highlighted
has changed.
