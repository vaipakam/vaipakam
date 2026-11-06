# Keeper alerts the ops chat when Base refuses a reward remit

The keeper sends each mirror its daily reward budget from Base. On 2026-11-06, Base's delivered reward budget was empty because its reward pool was never funded after the fresh deploy, so the Diamond refused every one of these sends. The keeper retried every run for hours and wrote only a log line, so nothing told an operator.

Now, when the Diamond answers and refuses a remit, the keeper posts one alert to the ops chat for that lane, naming the refusal and its figures. It re-posts every six hours while the refusal persists, and the alert clears once the lane next completes. A refusal that a later run resolves by itself (a duplicate send finding the days already remitted) is not alerted, and neither are network failures, which say nothing about the call.
