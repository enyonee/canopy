# mailer — webgen-bench/000042

## Weakened cases
- Not reviewed yet: this file was started with the ownership fix below, the cases themselves are unchanged.

## Misses
- Runtime, not the format: a sender may still `POST /EmailRecipient` (or `/Attachment`) with `email` set to
  another sender's draft. A one-hop `own` ("email.owner") scopes view/edit/delete, but create neither checks
  the parent of the new row nor fills anything, so the row lands under the other draft. Closed by the runtime
  fix SEC3 (one-hop own on create/edit/related add); until it lands, check 3 fails on exactly this assertion
  ("another sender added a recipient to Sam's draft").

## New for this app
- Recipient lines and attachments belong to the draft's owner: `EmailRecipient` and `Attachment` are granted
  with `own: "email.owner"` (also for the assistant role of change 1). Before, they were granted without `own`,
  so any sender listed every draft's recipients through `/EmailRecipient` (JSON), opened them by id and deleted
  them, although the drafts themselves were already owner-only. Check 3 now signs in a second sender and
  asserts she lists none of Sam's lines and files and gets 403 on opening, downloading and deleting them;
  the change-1 check asserts the assistant lists only her own line.
