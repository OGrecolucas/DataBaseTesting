# Populating United Tables · query sketch (21.10.2026)

This page sketches the queries that fill the five tables of [United Tables](https://e-conomic.slite.com/app/docs/qOrGOdqMmd). It starts from what the dashboard shows and works back to the sources. **It is a sketch, not runnable code.** Columns written as `‹?›` are join columns that still have to be confirmed on qa17.

It follows the job Rodrigo proposed on 21.10:
- every night, only the items that changed that day are classified again;
- once a week, the old items that are still open are reviewed;
- frozen months are never read again;
- the job reads the replica, by setup and in batches, and recounts the totals only for the clients that changed.


## 1. From the dashboard back to the queries

| Dashboard element | Formula | Read from | Filled by |
| --- | --- | --- | --- |
| Automation rate (headline) | (A1 + A2a + A2b + A3) ÷ Processed | Table 2 | Q6, from Q4 |
| One-click entries | OneClick ÷ Processed | Table 2 | Q6, from Q4. One-click detection is still open |
| Tier split | Each tier ÷ Processed | Table 2 | Q6 |
| One bar per automation (e.g. Workflows 20%, AutoSuggest 35%, Auto-reconcile 76%) | Usage = Used ÷ Eligible, **or** Contribution = (Kept + KeptPartially) ÷ Processed | Table 3 | Q7, from Q3 |
| Why is this item in its tier? | `TierSignal`, or `ManualReason` for Manual | Table 1 | Q4 |
| Office and group rate | Counts of table 2 added over the office's clients, then divided once | Tables 2 and 4 | Q6, Q8 |
| Day by day | Same counts per arrival day | Table 2d | Q6 |

**To decide: what the bars show.** Usage and contribution can be very far apart. For example, Auto-reconcile can act on 76% of the lines where it could act and still help with only 10% of the month's work. Table 3 has the counters for both.


## 2. The night run, step by step

```
Q0 keys to process ─► Q1 item and arrival ─► Q2 lifecycle ─► Q3 signals and outcomes ─► Q4 tier
                                                                                          │
                                                                          Q5 write table 1
                                                                                          │
                        Q8 table 4          Q6 tables 2 and 2d, Q7 table 3  ◄─────────────┘
                                            (only the touched clients and months)
```

Every step works on one batch of keys at a time, in a temp table `#Keys (SetupId, Flow, ItemId)`. A batch holds one or more SetupIds and about 50 k items, read from the replica. On staging a night is 1–2.5 M items, so 20–50 batches.

### Q0 · Which items to process tonight

An item has to be classified again when it arrived, or when one of its sources got a new or changed row. Each source table has its own watermark: either the last `Id` read or, where one exists, a change date. The watermarks are stored in `automation.JobRun` and move forward only when the run has succeeded.

```sql
-- items of the open months only: a frozen month is never changed again
INSERT INTO #Keys (SetupId, Flow, ItemId)
SELECT b.SetupId, 1, b.Id                            -- new bank lines
FROM   BankafstemningBank b
WHERE  b.Id > @wm_BankafstemningBank AND b.CreatedAtUTC >= @openFromUtc
UNION
SELECT b.SetupId, 1, b.Id                            -- reconciled, linked to a booked line
FROM   BankafstemningPostering bp
JOIN   BankafstemningBank b ON b.Id = bp.‹BankLineId›
WHERE  bp.‹Id› > @wm_BankafstemningPostering AND b.CreatedAtUTC >= @openFromUtc
UNION
SELECT ‹item of the line›                            -- booked or reversed lines -> their voucher -> document or bank line
FROM   Postering p
WHERE  p.‹Id› > @wm_Postering   -- or a change date, if a reversal is an update in place
UNION
SELECT ‹item›                                        -- workflow ran or changed status
FROM   BankEntryWorkflowStatus w
WHERE  w.‹Id› > @wm_Workflow OR w.‹ChangedAt› >= @since
UNION
SELECT ‹item›                                        -- document attached to a bank line
FROM   BankEntryDocument e
WHERE  e.‹Id› > @wm_BankEntryDocument
UNION
SELECT ‹item›                                        -- auto-reconcile (after go-live)
FROM   BankReconciliationMatch m
WHERE  m.‹Id› > @wm_Match
UNION
SELECT d.‹SetupId›, 2, d.BilledNr                    -- new or changed documents
FROM   BilagsBillede d
WHERE  (d.BilledNr > @wm_BilagsBillede OR d.‹ChangedAt› >= @since) AND d.CreationDate >= @openFrom
UNION
SELECT l.SetupId, 1, l.BankEntryId                   -- new AutoSuggest logs (landing table, Q3b)
FROM   automation.BankAutoSuggestLog l
WHERE  l.IngestedAtUtc >= @since
UNION
SELECT d.‹SetupId›, 2, d.BilledNr                    -- time thresholds: no row changes, but the lifecycle does
FROM   BilagsBillede d
WHERE  d.Status = 2 AND d.CreationDate >= DATEADD(day, -91, @today) AND d.CreationDate < DATEADD(day, -90, @today);
-- the same for workflows that have been running for exactly 7 days (OpenSubStatus WorkflowStuck)
```

A hard-deleted bank line has no row left, so it never shows up here. The weekly run (Q9) catches it.

### Q1 · Item and arrival

```sql
SELECT k.SetupId, k.Flow, k.ItemId,
       o.‹AgreementNo›                               AS AgreementNo,
       b.CreatedAtUTC                                AS ArrivedAtUtc,   -- documents: d.CreationDate
       ‹Copenhagen date of ArrivedAtUtc›             AS ArrivalDate,
       ‹first day of that month›                     AS ArrivalMonth,
       d.SourceType, b.‹BankEntrySourceType›, ‹ArrivedAutoTriggerable›
FROM   #Keys k
JOIN   Opsaetning o              ON o.‹SetupId› = k.SetupId
LEFT JOIN BankafstemningBank b   ON k.Flow = 1 AND b.Id = k.ItemId
LEFT JOIN BilagsBillede d        ON k.Flow = 2 AND d.BilledNr = k.ItemId
WHERE  ‹not a copied document, card receipt or bank-entry upload›;
```

The Copenhagen conversion is done once per row in the select list, never in a `WHERE`, where it would stop the index from being used.

### Q2 · Lifecycle (first match wins)

```sql
-- bank lines
Lifecycle = CASE
    WHEN b.IsDeleted = 1 OR b.FalskPostering = '1'                          THEN 5  -- Removed
    WHEN b.Afstemt = '1' AND EXISTS (SELECT 1 FROM BankafstemningPostering bp
                                     WHERE bp.‹BankLineId› = b.Id
                                       AND bp.KladdePostering = '0')        THEN 2  -- Processed
    ELSE                                                                         1  -- Open
END

-- documents
Lifecycle = CASE
    WHEN d.DeletedAt IS NOT NULL                                            THEN 5  -- Removed
    WHEN EXISTS (BankEntryDocument row for d) OR ‹voucher came from a bank transfer›
                                                                            THEN 4  -- ConsumedByBankLine
    WHEN EXISTS (Postering p on d's ‹voucher› WHERE p.Status = 1)           THEN 2  -- Processed
    WHEN (d.Status = 2 AND ‹no voucher› AND d.CreationDate < DATEADD(day, -90, @today))
      OR d.Status = 6                                                       THEN 3  -- ClosedWithoutBooking
    ELSE                                                                         1  -- Open
END
```

The same pass also gives `OpenSubStatus` and `ProcessedAtUtc`, the date of the first current booked line. For bank lines it gives `LinkedEntries`, the number of booked entries the line is reconciled to.

### Q3 · Signals and outcomes

There is one `LEFT JOIN` or `OUTER APPLY` per source, and each returns a few columns per item. Each join gives both the signal (`Sig_*`) and that automation's outcome column: 0 NotEligible, 1 NotUsed, 2 Kept, 3 KeptPartially, 4 Corrected, 5 Rejected, 6 Used with outcome not known yet.

| Signal | Sketch | Source |
| --- | --- | --- |
| S1 AutoBookedThenCorrected | A line of the item's entry has `rel_Postering_Tag.TagId = 1` and `Postering.Status = 0` | SQL. Only from mid-November 2025 |
| S2 PreparedByWorkflow | The item's workflow row has `Status = 2`, its last action is in (`sendToJournal`, `sendToSmartInbox`, `book`), the approval was not rejected, and the action is not `keepCardTransactionInBankRec`. `IsGlobalWorkflow` comes from the rule | SQL (`BankEntryWorkflowStatus`, document workflows), plus `ApprovalFlow` |
| S3 BankAutoSuggestKept | See Q3b | Landing table of the Mongo logs |
| S4 InboxAutoSuggestKept | The first accessible predicted account equals the booked account (finance voucher: account and contra). Supplier defaults are excluded | ‹?› predictions, probably Mongo `inboxSuggestions` |
| S5 SmartScanKept | `ScanningStatus = 2`, and the scanned amount equals the booked amount (±0.01, same currency) | `BilagsBillede`, plus the scanned amount ‹?› (`BilagsExtractedData`?) |
| S6 EInvoiceKept | `SourceType = 3`, and the e-invoice amount equals the booked amount (±0.01) | `BilagsBillede`, plus the e-invoice amount ‹?› |
| S7 AutoAttached | `AttachmentSource` 1 or 2 gives S7; 3 gives S7 external provider | SQL |
| S8 AutoReconciled | `BankReconciliationMatch.Method` 2 or 6 gives S8; 5 gives S8 system job | SQL. Only after go-live |

Example of one outcome column:

```sql
SmartScanOutcome = CASE
    WHEN d.SourceType NOT IN (1, 2, 5, 9)          THEN 0   -- NotEligible: not a scanned source
    WHEN d.ScanningStatus <> 2                     THEN 1   -- NotUsed
    WHEN ABS(‹scanned amount› - ‹booked amount›) <= 0.01
     AND ‹same currency›                           THEN 2   -- Kept
    ELSE                                                4   -- Corrected
END
```

### Q3b · Bank AutoSuggest (S3) from Mongo

Once a night, the job reads each collection once, by date range (the TTL index is on `CreatedAt`), and only the fields it needs. It bulk-inserts the result into `automation.BankAutoSuggestLog`. S3 is then decided in SQL, never with a Mongo lookup per bank line.

```js
// FinalSuggestionLog, AutoSuggestUsedLog, EntryTransferredLog, SuggestionLog: yesterday's documents only
db.FinalSuggestionLog.find(
    { CreatedAt: { $gte: since, $lt: until } },
    { SetupId: 1, BankEntryId: 1, CreatedAt: 1, AutoSuggestSource: 1, EntryType: 1, EntryTypeValue: 1, InvoiceId: 1 })
// SuggestionLog: only SetupId, BankEntryId, CreatedAt, AutoSuggestSource (the engine), to tell a person from bank automation
```

```sql
-- per bank line: the transfer, and the last final suggestion before it
S3 = 1 WHEN
        f.AutoSuggestSource <> 'NotSuggested'                                   -- a real suggestion was shown
    AND EXISTS (Used log between f.CreatedAt and t.CreatedAt)                   -- the person used it
    AND EXISTS (engine <> StaticRulesV1/V2 in the 5 s before f.CreatedAt)       -- the screen, not bank automation
    AND t.EntryType = f.EntryType AND t.EntryTypeValue = f.EntryTypeValue
    AND ‹same invoices›                                                         -- kept at transfer
S3 partial = the same, but the invoices differ
S3 = NULL when the month has no Mongo data (before Jan 2026)                    -- skipped, never "corrected"
```

The landing table also keeps the evidence beyond the 400-day Mongo TTL. The logs of Jan 2026 start to expire around 5.2.2027.

### Q4 · Tier (first match, only from the columns of Q2 and Q3)

```sql
Tier = CASE
    WHEN Lifecycle <> 2                                     THEN NULL
    WHEN Sig_AutoBookedThenCorrected = 1
      OR Sig_PreparedByWorkflow = 1                         THEN 1   -- A1  Ready to book
    WHEN Sig_BankAutoSuggestKept = 1 OR Sig_BankAutoSuggestPartial = 1
      OR Sig_InboxAutoSuggestKept = 1 OR Sig_InboxAutoSuggestPartial = 1
                                                            THEN 2   -- A2a Account suggested
    WHEN Sig_SmartScanKept = 1 OR Sig_EInvoiceKept = 1      THEN 3   -- A2b Data filled in
    WHEN Sig_AutoAttached = 1 OR Sig_AttachedByExternalProvider = 1
      OR Sig_AutoReconciled = 1 OR Sig_ReconciledBySystemJob = 1
                                                            THEN 4   -- A3  Matched
    ELSE                                                         5   -- Manual
END
TierSignal   = code of the first signal that matched (10, 20, 30, 31, 40, 41, 50, 60, 70, 71, 80, 81)
ManualReason = only for Manual: SuggestedButCorrected, SuggestionRejected, NoSuggestion, …, NoData (a signal was NULL)
```

**Shared entries.** This covers instalments, and one entry that books 40 card payments reconciled to 40 bank lines (on staging, 2.5 k of 6 M bank lines). The signals of the entry (S1, S2) go only to the first bank line of that entry. The other lines keep only their own signals (S3, S7, S8):

```sql
EntryRank = ROW_NUMBER() OVER (PARTITION BY SetupId, EntryKey ORDER BY ProcessedAtUtc, ItemId)
-- S1 and S2 count only where EntryRank = 1; SharedEntry = 1 where the entry has more than one item
```

The tier is decided only from these columns. So the same expression can rebuild a frozen month from its stored signals in BigQuery when a new `MetricVersion` comes.

### Q5 · Write table 1

```sql
-- rows of the batch in #Result, with RowHash = HASHBYTES over the classification columns (not ComputedAtUtc)
UPDATE f SET <all columns>, ComputedAtUtc = SYSUTCDATETIME()
FROM   automation.WorkItemAutomationFact f
JOIN   #Result r ON r.ArrivalMonth = f.ArrivalMonth AND r.SetupId = f.SetupId AND r.Flow = f.Flow
                AND r.ItemId = f.ItemId AND f.MetricVersion = @v
WHERE  f.RowHash <> r.RowHash;                         -- only rows that really changed

INSERT INTO automation.WorkItemAutomationFact (...)
SELECT ... FROM #Result r
WHERE  NOT EXISTS (SELECT 1 FROM automation.WorkItemAutomationFact f WHERE <same key>);

INSERT INTO #Touched (SetupId, ArrivalMonth)           -- for Q6 and Q7
SELECT DISTINCT SetupId, ArrivalMonth FROM <rows updated or inserted>;
```

### Q6 · Tables 2 and 2d (touched clients only)

```sql
DELETE m FROM automation.AgreementAutomationMonthly m
JOIN   #Touched t ON t.SetupId = m.SetupId AND t.ArrivalMonth = m.MonthStart
WHERE  m.MetricVersion = @v;

INSERT INTO automation.AgreementAutomationMonthly (...)
SELECT f.AgreementNo, f.SetupId, f.ArrivalMonth, f.Flow,
       COUNT(*)                                          AS Arrived,      -- includes removed items
       SUM(CASE WHEN f.Lifecycle = 5 THEN 1 ELSE 0 END)  AS Removed,
       SUM(CASE WHEN f.Lifecycle = 4 THEN 1 ELSE 0 END)  AS ConsumedByBankLine,
       SUM(CASE WHEN f.Lifecycle = 3 THEN 1 ELSE 0 END)  AS ClosedWithoutBooking,
       SUM(CASE WHEN f.Lifecycle = 1 THEN 1 ELSE 0 END)  AS OpenItems,
       SUM(CASE WHEN f.Lifecycle = 2 THEN 1 ELSE 0 END)  AS Processed,
       SUM(CASE WHEN f.Tier = 1 THEN 1 ELSE 0 END)       AS AssistedA1,
       SUM(CASE WHEN f.Tier = 2 THEN 1 ELSE 0 END)       AS AssistedA2a,
       SUM(CASE WHEN f.Tier = 3 THEN 1 ELSE 0 END)       AS AssistedA2b,
       SUM(CASE WHEN f.Tier = 4 THEN 1 ELSE 0 END)       AS AssistedA3,
       SUM(CASE WHEN f.Tier = 5 THEN 1 ELSE 0 END)       AS Manual,
       SUM(CAST(f.OneClick AS int))                      AS OneClick,     -- NULL while not detectable
       SUM(CAST(f.BookedByWorkflow AS int))              AS BookedByWorkflow,
       SUM(CAST(f.EditedAfterBooking AS int))            AS EditedAfterBooking,
       SUM(CASE WHEN f.TierSignal = 10 THEN 1 ELSE 0 END) AS AutoBookedThenCorrected,
       ‹PlanId of the month›, ‹IsSettled›, ‹HasBankAutoSuggestData›, ‹HasReconcileMethodData›, ‹HasCorrectionData›,
       @v, SYSUTCDATETIME()
FROM   automation.WorkItemAutomationFact f
JOIN   #Touched t ON t.SetupId = f.SetupId AND t.ArrivalMonth = f.ArrivalMonth
WHERE  f.MetricVersion = @v
GROUP BY f.AgreementNo, f.SetupId, f.ArrivalMonth, f.Flow;

-- table 2d: the same, grouped by ArrivalDate instead of ArrivalMonth, without PlanId and the month flags
```

The checks of the old test script run after this step, and a failed check stops the run before the watermarks move:
- `Processed` = `A1 + A2a + A2b + A3 + Manual`
- `Arrived` = the sum of the lifecycles
- bank rows have no ConsumedByBankLine or ClosedWithoutBooking items

### Q7 · Table 3 (one row per automation)

The nine outcome columns of table 1 are unpivoted into one row per automation:

```sql
SELECT f.AgreementNo, f.SetupId, f.ArrivalMonth, f.Flow, x.Feature,
       SUM(CASE WHEN x.Outcome >= 1 THEN 1 ELSE 0 END)                            AS Eligible,
       COUNT(DISTINCT CASE WHEN x.Outcome >= 2 THEN COALESCE(f.EntryKey, f.ItemId) END) AS Used,   -- an entry counts once
       SUM(CASE WHEN x.Outcome = 2 THEN 1 ELSE 0 END)                             AS Kept,
       SUM(CASE WHEN x.Outcome = 3 THEN 1 ELSE 0 END)                             AS KeptPartially,
       SUM(CASE WHEN x.Outcome = 4 THEN 1 ELSE 0 END)                             AS Corrected,
       SUM(CASE WHEN x.Outcome = 5 THEN 1 ELSE 0 END)                             AS Rejected,
       SUM(CASE WHEN x.Unattended = 1 THEN 1 ELSE 0 END)                          AS Unattended,
       SUM(CASE WHEN ‹feature of f.TierSignal› = x.Feature THEN 1 ELSE 0 END)     AS DecidedTier
FROM   automation.WorkItemAutomationFact f
JOIN   #Touched t ON t.SetupId = f.SetupId AND t.ArrivalMonth = f.ArrivalMonth
CROSS APPLY (VALUES
       (1, f.WorkflowOutcome,         f.WorkflowUnattended),
       (2, f.GlobalWorkflowOutcome,   NULL),
       (3, f.ApprovalOutcome,         NULL),
       (4, f.BankAutoSuggestOutcome,  NULL),
       (5, f.InboxAutoSuggestOutcome, NULL),
       (6, f.SmartScanOutcome,        NULL),
       (7, f.EInvoiceOutcome,         NULL),
       (8, f.AutoAttachOutcome,       f.AutoAttachUnattended),
       (9, f.AutoReconcileOutcome,    NULL)) AS x(Feature, Outcome, Unattended)
WHERE  f.Lifecycle = 2 AND f.MetricVersion = @v AND x.Outcome IS NOT NULL
GROUP BY f.AgreementNo, f.SetupId, f.ArrivalMonth, f.Flow, x.Feature;
```

Then, per client and month:
- `CanUse` comes from the plan, modules and add-ons (`PakkeLoesningsNr`, `BenyttetModulAftalenr`, `LicensingDomainService`).
- `Configured` comes from Hermes, mapped by `SetupId`. The source is ‹?›, to confirm with the Workflows team.
- `HasData` is 0 where the source had no data that month.
- Feature 10 (bank feed) is counted from `OctopusId` / `NagApiTransactionId`.

### Q8 · Table 4 (offices)

```sql
INSERT INTO automation.AdminPortfolioMonthly (AdminAgreementNo, AgreementNo, SetupId, MonthStart, IsBackfilled, ComputedAtUtc)
SELECT a.‹AdminAgreementNo›, a.‹AgreementNo›, o.‹SetupId›, @monthStart, 0, SYSUTCDATETIME()
FROM   AdminAftale a
JOIN   Opsaetning o ON ‹agreement of a›
WHERE  (a.ExpireTime IS NULL OR a.ExpireTime > SYSUTCDATETIME())
  AND  ‹agreement not cancelled, not an archive plan›
  AND  a.‹AgreementNo› <> ‹Administrator.PartialBillingExclusionAgreementNumber of the office›
  AND  NOT EXISTS (SELECT 1 FROM automation.AdminPortfolioMonthly p
                   WHERE p.AdminAgreementNo = a.‹AdminAgreementNo› AND p.AgreementNo = a.‹AgreementNo›
                     AND p.MonthStart = @monthStart);
```

### Q9 · Weekly review

This is Rodrigo's review: it classifies again every item of the open months that is still open (about 8 M on staging), through Q1–Q7.

```sql
INSERT INTO #Keys
SELECT SetupId, Flow, ItemId FROM automation.WorkItemAutomationFact
WHERE  Lifecycle = 1 AND ArrivalMonth >= @firstOpenMonth AND MetricVersion = @v;
```

Two cheap checks cover what an open-only review cannot see:
- **Processed items that change without leaving a date**: a line unreconciled, a document detached, a booked line reversed in place, or an `AttachmentSource` overwritten. The check compares per `(SetupId, ArrivalMonth)` the reconciled bank lines and booked documents in the source with `Processed` in table 1. Only the setups that differ are classified again.
- **Hard-deleted bank lines**: rows of table 1 whose `ItemId` no longer exists in `BankafstemningBank` become `Removed`. `EntryDeletedFromBankLog` in Mongo may give the same thing without the anti-join.

### Freezing a month

After the weekly run, a month older than the window is frozen:
1. Its partition of table 1 is exported to BigQuery once. The BIExtract delta works by MaxID, so it would miss rows that were updated.
2. The partition is switched out of SQL Server. All indexes must be aligned to the partition, the columnstore included.


## 3. Volumes (staging, Rodrigo 21.10)

| What | Staging | Means |
| --- | --- | --- |
| Items in the 4 open months | ~72 M | Table 1 in SQL Server ≈ 8 GB of data, ~15 GB with indexes |
| Items changed per night | 1–2.5 M | 20–50 batches of 50 k |
| Old items still open, weekly | ~8 M | The heaviest run, once a week |
| Bank lines sharing an entry | 2.5 k of 6 M (0.04%) | Small for the headline, but it can inflate the per-automation bars of one client |

The doc's estimate of 5–8 M items a month is below staging (72 M ÷ 4 = 18 M a month). The production volume still has to be confirmed (ICO, Q1).


## 4. What the queries need that the tables do not have yet

- **`EntryKey` in table 1**: the booked entry or voucher the item ended in. Without it, neither the shared-entry rule (Q4) nor "an automation counts once per entry" (Q7) can be computed. `SharedEntry` and `LinkedEntries` say that an item shares an entry, not with which items.
- **`RowHash` in table 1**, so Q5 writes only the rows that changed.
- **`automation.JobRun`**: one row per run, with the watermark per source table, rows read and written, duration and status. The night run can then resume after a failure, and the watermarks move only after a successful run.
- **`automation.BankAutoSuggestLog`**: the landing table for the Mongo logs (Q3b).
- **A decision on the bars**: usage or contribution (section 1).


## 5. To confirm on qa17 before writing the real queries

- The join columns marked `‹?›`:
  - bank line ↔ `BankafstemningPostering` ↔ `Postering`;
  - document ↔ voucher;
  - the keys of `BankEntryDocument`;
  - the workflow row ↔ its item.
- Q0: which tables have an identity `Id` or a change date, and whether booking, reversing, reconciling, attaching and a workflow run are inserts or updates in place.
- Where the scanned amount (S5), the e-invoice amount (S6) and the Inbox predictions (S4) are stored.
- Where `Configured` is read from in Hermes.
