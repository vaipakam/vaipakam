## Connected app — risk-level copy stops fighting the page layout (user feedback 2026-08-03)

The Risk access page listed the levels safest-first, top to bottom —
but its cooldown note said "moving down is instant, moving up may
wait", using an invisible risk-ladder metaphor where "up" means
riskier. On screen, the riskier choice sits LOWER, so the words and
the layout pointed in opposite directions. The note now names the
thing itself ("choosing a safer level applies instantly; choosing a
riskier level may wait out a short safety cooldown").

The notice shown after picking a riskier level was reworded the same
way, and now also stops overstating what happened: instead of
announcing the level as raised (or as already in use), it says the
riskier level is saved, and that it applies immediately — or, where a
safety cooldown is configured, once that cooldown finishes. That
matches what the vault actually does: the choice is recorded straight
away, but it is selected-and-pending rather than in force for the
whole cooldown window.
