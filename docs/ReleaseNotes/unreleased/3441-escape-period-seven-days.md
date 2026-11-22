## Thread — The escape route after a long pause now opens after seven days (branch, no PR yet)

When an admin pause runs long enough, every owner may take what is free in their vault straight to their own wallet. That escape period was three days by default, and the admin could set it between 49 hours and seven days.

A vault code fix needs seven days in public before it can go live. With a three-day escape period, the escape route opened on day three, before any fix could land, so a bug on the withdraw path itself would have become reachable through the escape. The escape period is now seven days by default and can never be set shorter than the vault code delay. The admin may raise it to ten days, which stays well under the fourteen-day vault-side exit planned in #3424 (owner decision 2026-11-15).

Each pause still keeps the period in force when it started. The incident runbook now says to register a vault fix on the first day of a pause, so its seven-day window ends no later than the escape opens. The app's pause notice says seven days.

Closes #3441.
