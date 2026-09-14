# rentals — webgen-bench/000038

## Weakened cases
- Case 3 (dates marked as unavailable in the calendar): there is no calendar and no overlap check; booked dates are listed as a table on the apartment page with their status. Two bookings for the same dates are not refused.
- Case 4 (user account section): the guest is the identity profile, so "My bookings" is a saved list on `guest = @me` rather than an account area with login.

## Misses
- Availability calendar / blocking overlapping bookings — `block` (a rule that can compare the submitted range with sibling rows; rules see only the row and one hop, and an aggregate cannot take the new row's dates as parameters).
- Date arithmetic for "booked until" — `block` (`max(Booking: checkOut)` is refused because max needs numbers; no date functions besides `days()`).

## New for this app
- `days()` in a derived int (`nights`) feeding a derived money (`nights * apartment.nightly`) through a reference.
- A rule comparing two date fields (`checkOut > checkIn`) on a related-form submit.
- A related table on the parent used both as the booking form (`fill: {guest: "@me"}`, two fields) and as the "booked dates" view.
