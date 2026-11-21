# Subcontractor checks

A check written to a subcontractor is recorded in two places.

- **QuickBooks:** a check from Marion County checking to that vendor, with the check number, dated the day it was written. The memo is the job number. The category is the one used on earlier checks to the same vendor, so the payment stays on the 1099. The vendor is marked for 1099 tracking when that flag is off.
- **Jobber:** an expense on the job, for the same amount and date. This is written only when the check names a job number and that job exists. A blank “for” line is not guessed.

`record_subcontractor_check` with `apply: false` shows the plan and the earlier checks. `apply: true` writes. It skips a check number already in QuickBooks, and a Jobber expense that already names that check.
