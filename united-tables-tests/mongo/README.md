# MongoDB tests · results of 21.10.2026 (qa02)

These four scripts check the parts of the [United Tables](https://e-conomic.slite.com/app/docs/qOrGOdqMmd) model that live in MongoDB: the AutoSuggest logs behind signal **S3 (Bank AutoSuggest kept)**. This page explains what each script does and shows what it returned on qa02.

**All four scripts are read-only.** They only count, find and aggregate.


## Summary

| Script | Question | Answer on qa02 |
| --- | --- | --- |
| `m01_overview.js` | Which collections exist, with which fields? | All 7 AutoSuggest log collections exist and have data, including `EntryTransferredLog` (22 documents), which was missing from the 19.10 export |
| `m02_s3_rule.js` | Does the updated S3 rule hold? | Yes for the negative case: 4 lines have an `AutoSuggestUsedLog` but no suggestion was shown, and the rule does not count them. No line had a real suggestion, so the positive case could not be tested |
| `m03_engines_per_line.js` | How many log documents per bank line? | 4.33 on average (4 or 6); one engine found something on 4 lines, but nothing was shown |
| `m04_export_ids.js` | Ids for the SQL join test | 24 bank lines, with different setups than the 19.10 export (the env was rebuilt in between) |

**The data is test data.** Every document was written on 19.10 between 16:27 and 16:29 UTC, in 2 minutes, by what looks like an automated test run after a deploy. It confirms the structure and the rules, not real rates.

## m01 · Overview

```
Database: bankReconciliation

ok        SuggestionLog  documents: 104  from: 2026-10-19T16:27:51.338Z  to: 2026-10-19T16:29:48.556Z
          fields: _id, SetupId, BankEntryNumber, BankEntryId, CreatedAt, EntryType, EntryTypeValue, InvoiceId, AutoSuggestSource, Confidence, Amount
ok        FinalSuggestionLog  documents: 24  from: 2026-10-19T16:27:51.406Z  to: 2026-10-19T16:29:48.634Z
          fields: _id, SetupId, BankEntryNumber, BankEntryId, CreatedAt, EntryType, EntryTypeValue, InvoiceId, AutoSuggestSource, Confidence, Amount
ok        AutoSuggestUsedLog  documents: 4  from: 2026-10-19T16:27:51.458Z  to: 2026-10-19T16:27:54.274Z
          fields: _id, SetupId, BankEntryNumber, BankEntryId, CreatedAt
ok        EntryTransferredLog  documents: 22  from: 2026-10-19T16:27:58.640Z  to: 2026-10-19T16:29:48.127Z
          fields: _id, SetupId, BankEntryNumber, BankEntryId, CreatedAt, EntryType, EntryTypeValue, InvoiceId
ok        EntrySavedLog  documents: 3  from: 2026-10-19T16:28:14.016Z  to: 2026-10-19T16:28:14.016Z
          fields: _id, SetupId, BankEntryNumber, BankEntryId, CreatedAt, EntryType, EntryTypeValue, InvoiceId
ok        EntryBookedLog  documents: 1  from: 2026-10-19T16:28:43.063Z  to: 2026-10-19T16:28:43.063Z
          fields: _id, SetupId, BankEntryNumber, BankEntryId, CreatedAt, EntryType, EntryTypeValue, InvoiceId
ok        EntryDeletedLog  documents: 10  from: 2026-10-19T16:28:00.621Z  to: 2026-10-19T16:28:28.970Z
          fields: _id, SetupId, BankEntryNumber, BankEntryId, CreatedAt
ok        BankReconciliationAccountChecksum  documents: 11  from: 2026-10-19T16:27:22.901Z  to: 2026-10-19T16:29:22.723Z
          fields: _id, Checksum, CreatedAt, UpdatedAt

S3 can be tested: EntryTransferredLog has 22 documents. Run m02_s3_rule.js next.
```

**What it tells us**

- **Every log carries the same three keys:** `SetupId`, `BankEntryNumber` and `BankEntryId`, so all collections can be joined per bank line.
- **`EntryTransferredLog` has the same fields as the suggestion** (`EntryType`, `EntryTypeValue`, `InvoiceId`). So "was the suggestion kept at transfer?" can be decided by comparing those three fields between the last `FinalSuggestionLog` and the `EntryTransferredLog`. This is exactly the S3 rule of the doc: entry type, party (most likely `EntryTypeValue`) and invoices.
- **`EntryDeletedLog` exists (10 documents).** It may help with the open question of deleted bank lines (doc 7.1): if it logs deleted bank lines, the daily run could count `Removed` from it even when the SQL row is gone. To check: does it log the deletion of the bank line, or of the entry made from it?

## m02 · S3 rule

```
Database: bankReconciliation   window: last 30 days   join key: SetupId + BankEntryId

Bank lines with a final suggestion in the window: 24

Lines per combination of the four steps:
      20  shown=false used=false transferred=true inOrder=false
       2  shown=false used=true transferred=false inOrder=false
       2  shown=false used=true transferred=true inOrder=true

Used log but final suggestion NotSuggested (must NOT count as S3): 4
S3 candidates (shown, used, transferred after the suggestion):     0

Final suggestion source (AutoSuggestSource):
      24  NotSuggested
```

For each bank line the script checks four steps: a suggestion was **shown** (final source is not `NotSuggested`), the user **used** it (`AutoSuggestUsedLog`), the line was **transferred** (`EntryTransferredLog`), and the suggestion came **before** the transfer.

| Lines | What happened | Tier in the doc |
| --- | --- | --- |
| 20 | No suggestion, no click, transferred by hand | Manual (`ManualReason` NoSuggestion) |
| 2 | Clicked AutoSuggest, nothing was suggested, not transferred | Not processed yet |
| 2 | Clicked AutoSuggest, nothing was suggested, then transferred | Manual. An older rule ("used log = S3") would have wrongly counted these as A2a |

**What it tells us**

- **The negative case of the updated S3 rule is confirmed.** 4 lines have an `AutoSuggestUsedLog` with no suggestion behind it, and 2 of them were even transferred. Counting the used log alone would have put those 2 lines in A2a. The doc's rule (also require a final suggestion that is not `NotSuggested`) keeps them out.
- **The positive case is not tested.** No line had a real suggestion, so there are 0 S3 candidates, and nothing to compare "kept or changed" on.
- **The join on `SetupId + BankEntryId` works:** the 22 transferred lines (20 + 2) match the 22 documents of `EntryTransferredLog`.

## m03 · Log documents per bank line

```
Database: bankReconciliation   window: last 30 days

SuggestionLog documents per bank line:
    4 docs: 20 lines
    6 docs: 4 lines
Bank lines: 24   documents: 104   average per line: 4.33

Per engine (AutoSuggestSource):
  StaticRulesV2    docs:     24  confidence>0:      4  with entry type:      4  with invoice:      0
  FullTextSearch   docs:     24  confidence>0:      0  with entry type:      0  with invoice:      0
  VML              docs:     24  confidence>0:      0  with entry type:      0  with invoice:      0
  CommonModel      docs:     24  confidence>0:      0  with entry type:      0  with invoice:      0
  StaticRulesV1    docs:      4  confidence>0:      0  with entry type:      0  with invoice:      0
  VectorSearch     docs:      4  confidence>0:      0  with entry type:      0  with invoice:      0

FinalSuggestionLog by AutoSuggestSource:
  NotSuggested     24
```

**What it tells us**

- **Volume:** four engines run on every bank line (StaticRulesV2, FullTextSearch, VML, CommonModel), and two more on some lines (StaticRulesV1, VectorSearch). That makes 4 to 6 `SuggestionLog` documents per bank line, 4.33 on average. For the daily run, reading Mongo costs about 4–6 documents plus 1 final log per bank line, so it must read by `SetupId` and a `CreatedAt` window (doc section 4).
- **A suggestion was found but not shown.** StaticRulesV2 proposed an entry type on 4 lines, with a confidence above 0, yet the final suggestion is `NotSuggested` on all 24 lines. On the 19.10 export those confidences were 0.05 and 0.1, below any display threshold. This shows why S3 must read `FinalSuggestionLog` (what the user saw), not `SuggestionLog` (what each engine found).

## m04 · Ids for the SQL join test

```
-- 24 bank lines from bankReconciliation, paste into sql/11_qa02_bank_entry_id.sql:
    (30177645, 1, 705023428),
    (30177654, 1, 705023430),
    (30177675, 1, 705023429),
    (30177705, 1, 705023365),
    (30177705, 2, 705023366),
    (30177705, 6, 705023370),
    (30177705, 7, 705023371),
    (30177832, 1, 705023556),
    (30177849, 1, 705023574),
    (30177849, 2, 705023575),
    (30177849, 3, 705023576),
    (30177849, 4, 705023577),
    (30177849, 5, 705023578),
    (30177849, 6, 705023579),
    (30177849, 7, 705023580),
    (30177849, 8, 705023581),
    (30177903, 1, 705023744),
    (30177903, 2, 705023745),
    (30177903, 3, 705023746),
    (30177903, 4, 705023747),
    (30177903, 5, 705023748),
    (30177903, 6, 705023749),
    (30177903, 7, 705023750),
    (30177903, 8, 705023751);
```

**What it tells us**

- **The env was rebuilt between the 19.10 export and this run.** The export in `mongoDB-qa02-docs/` was written at 14:51 UTC; these logs at 16:27. Same day, same test pattern, but different setups.
- **The same `BankEntryId` values came back on different setups.** For example `705023428` belonged to setup `30177649` in the export and to `30177645` now. So after a rebuild, bank line ids restart from the same numbers. This does not matter in production, where data is never rebuilt, but on staging:
  - never join old exports with today's data;
  - **`sql/11_qa02_bank_entry_id.sql` still holds the old export.** Replace its `VALUES` list with the output above before running it, or it will report false mismatches.

## m05 · Who called AutoSuggest (not run yet)

Bank automation calls AutoSuggest too: when a client has an active bank rule with the `paymentType` criterion, the monolith asks AutoSuggest for **every** incoming bank line, before Hermes checks which rule matches, so also for lines that end with no matching workflow. It runs only StaticRules, and it logs the call exactly like a person's, including an `AutoSuggestUsedLog`, because `isUserCall` defaults to `true` and automation does not change it (code checked on 21.10; sources: Slite "Workflows: Bank and documents" and "AutoSuggest: runs without Flamel are bank automation runs").

Changing the code is outside our scope, so `m05` tells the two apart from the data:

- **screen:** the run has at least one non-static engine (CommonModel always, VML, FullTextSearch, VectorSearch by flag);
- **automation:** the run has only StaticRulesV1 / V2.

It ties each `AutoSuggestUsedLog` to the run just before it, and prints a list for `sql/12_workflow_autosuggest_check.sql`, which looks for a `BankEntryWorkflowStatus` row next to each run as a second, independent check. `m02` now also requires the run to be "by a person" (step 5) before a line counts as an S3 candidate.

On the qa02 data of 19.10 every line had CommonModel and the other screen engines, so all runs should come out as **screen** and the results above do not change. To see automation runs, use an env where a bank rule with `paymentType` ran on imported bank lines.

## What this means for United Tables

| Doc item | Result |
| --- | --- |
| S3 rule: an `AutoSuggestUsedLog` alone is not a kept suggestion (section 3) | **Confirmed**: 4 used logs with nothing suggested, 2 of them transferred |
| S3 "kept" comparison: entry type, party, invoices (section 3) | **Possible**: `EntryTransferredLog` carries `EntryType`, `EntryTypeValue`, `InvoiceId`, the same fields as the suggestion. Not tested yet: no real suggestion in the data |
| Join keys for table 1 (section 7.1) | **Confirmed in Mongo**: every log has `SetupId`, `BankEntryNumber`, `BankEntryId`. Whether `BankEntryId` = `BankafstemningBank.Id` is checked by `sql/11` |
| Reading Mongo by setup and time window (section 4) | **Confirmed**: 4–6 suggestion documents per bank line |
| Deleted bank lines (section 7.1) | **New lead**: `EntryDeletedLog` exists; to check what it logs |
| S3 must ignore AutoSuggest calls made by bank automation (section 3) | **Rule added, not tested yet**: a run with only StaticRules engines, or with a `BankEntryWorkflowStatus` row next to it, is automation (`m05`, `sql/12`) |

## Next steps

1. **Test S3 with a real suggestion.** In qa02, create a bank line that matches an existing rule or a known supplier, so AutoSuggest shows a suggestion. Transfer one line keeping the suggestion, and one after changing it. Then run `m02` again: it should show S3 candidates and print them next to their transfer.
2. **Update `sql/11`** with the `m04` output above, then run it on qa02 SQL (port 2002).
3. **Look at `EntryDeletedLog`.** Find which object it logs: the bank line, or the entry made from it.
4. **Explore `inboxSuggestions`**, which the same user can read. It probably holds the Inbox AutoSuggest predictions behind signal S4, which no test covers yet.
