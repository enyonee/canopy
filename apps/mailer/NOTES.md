# mailer — webgen-bench/000042

## Weakened cases
- Case 1 (compose "with fields for the subject, body, recipients, and attachment options"): the compose form
  has subject, body and template only. Recipients and attachments are child rows of the email, so they are
  added on the draft's own page once it is saved (the form's intro says so); check 1 asserts the subject and
  body fields, checks 2 and 3 the recipient and attachment forms on the draft.
- Case 2 ("added to the recipients' field in the compose email interface"): there is no recipients field; a
  picked recipient becomes a row of the draft's Recipients table, with its address derived from the address
  book. Check 2 asserts the row, the address and the draft's recipient count.
- Case 5 ("the sent emails section displays the recently sent email with the correct recipient and
  timestamp"): the Sent list shows the recipient *count* and the send time, not the addresses; the addresses
  are on the email's page. Check 5 asserts the count, the file count and that the row left Drafts; check 4
  asserts the send time and the addresses of the letters in the outbox.
- Case 3 (upload), until the runtime fix SEC3 lands: a sender may still `POST /EmailRecipient` (or
  `/Attachment`) with `email` set to another sender's draft. This is a runtime defect, not a format miss: a
  one-hop `own` ("email.owner") scopes view/edit/delete, but create neither checks the parent of the new row
  nor fills anything, so the row lands under the other draft. Check 3 asserts the refusal and so fails on
  exactly this ("another sender added a recipient to Sam's draft").

## Misses
- None found for this app: every case is expressed with data, child tables, a transition, an action and the
  mail connector.

## New for this app
- Recipient lines and attachments belong to the draft's owner: `EmailRecipient` and `Attachment` are granted
  with `own: "email.owner"` (also for the assistant role of change 1). Before, they were granted without `own`,
  so any sender listed every draft's recipients through `/EmailRecipient` (JSON), opened them by id and deleted
  them, although the drafts themselves were already owner-only. Check 3 now signs in a second sender and
  asserts she lists none of Sam's lines and files and gets 403 on opening, downloading and deleting them;
  the change-1 check asserts the assistant lists only her own line.
