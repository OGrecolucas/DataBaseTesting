/* =====================================================================
   m02 · Signal S3 (Bank AutoSuggest kept): does the updated rule hold?
   Tests:   United Tables, section 3, signal S3 and the rule
            "an AutoSuggestUsedLog alone is not a kept suggestion".
            For every bank line with a FinalSuggestionLog in the window it
            checks, step by step:
              1. shown:        final AutoSuggestSource is not NotSuggested
              2. used:         an AutoSuggestUsedLog exists for the line
              3. transferred:  an EntryTransferredLog exists for the line
              4. in order:     the final suggestion came before the transfer
              5. by a person:  the run that made the final suggestion has a
                               non-static engine (CommonModel, VML, ...).
                               Bank automation runs only StaticRules and logs
                               an AutoSuggestUsedLog too, so a run with only
                               StaticRules is not a person using AutoSuggest
                               (see m05_autosuggest_caller.js)
            and counts the lines in each combination. S3 candidates are the
            lines with all five. Whether the transfer KEPT the suggestion
            (entry type, party, invoices) is printed side by side for a few
            lines, to compare by hand: the field names of
            EntryTransferredLog are not confirmed yet.
   Env:     staging Mongo, database bankReconciliation (name set in DB_NAME). VPN (NoSplit).
   Run:     mongosh "<connection string>" --file mongo/m02_s3_rule.js
   Runtime: seconds on staging
   Safe:    read-only (aggregate and find). Nothing is written.

   Expected
   - "used but NotSuggested" > 0 confirms the qa02 finding of 19.10 and
     why S3 must check the final suggestion, not only the used log.
   - Lines with all four steps exist once someone has transferred lines
     with a real suggestion in this env. If there are none, S3 cannot be
     validated yet: generate a few transfers and run again.
   ===================================================================== */

const DB_NAME = 'bankReconciliation';  // database your Spook user can read (qa02: no -env suffix; see README)
const DAYS = 30;      // look-back window
const RUN_MS = 5000;  // engine logs of one run are written just before its FinalSuggestionLog
const STATIC = ['StaticRulesV1', 'StaticRulesV2'];
const brdb = db.getSiblingDB(DB_NAME);
const FROM = new Date(Date.now() - DAYS * 24 * 3600 * 1000);

// Join key: BankEntryId if EntryTransferredLog has it, otherwise BankEntryNumber
// findOne instead of getCollectionNames: the staging user may not list collections
const etlSample = brdb.EntryTransferredLog.findOne();
const KEY = etlSample && etlSample.BankEntryId !== undefined ? 'BankEntryId' : 'BankEntryNumber';
print('Database: ' + brdb.getName() + '   window: last ' + DAYS + ' days   join key: SetupId + ' + KEY);
if (!etlSample) print('WARNING: EntryTransferredLog is missing or empty; step 3 and 4 will be 0 for every line.');
print('');

const lines = brdb.FinalSuggestionLog.aggregate([
    { $match: { CreatedAt: { $gte: FROM } } },
    { $sort: { CreatedAt: 1 } },
    { $group: { _id: { SetupId: '$SetupId', key: '$' + KEY },
                final: { $last: '$$ROOT' }, finals: { $sum: 1 } } },
    { $lookup: { from: 'AutoSuggestUsedLog',
                 let: { s: '$_id.SetupId', k: '$_id.key' },
                 pipeline: [ { $match: { $expr: { $and: [ { $eq: ['$SetupId', '$$s'] }, { $eq: ['$' + KEY, '$$k'] } ] } } },
                             { $sort: { CreatedAt: 1 } }, { $limit: 1 } ],
                 as: 'used' } },
    { $lookup: { from: 'SuggestionLog',   // engines of the run behind the final suggestion
                 let: { s: '$_id.SetupId', k: '$_id.key', t: '$final.CreatedAt' },
                 pipeline: [ { $match: { $expr: { $and: [ { $eq: ['$SetupId', '$$s'] }, { $eq: ['$' + KEY, '$$k'] },
                                                          { $lte: ['$CreatedAt', '$$t'] },
                                                          { $gte: ['$CreatedAt', { $subtract: ['$$t', RUN_MS] }] } ] } } },
                             { $group: { _id: null, engines: { $addToSet: '$AutoSuggestSource' } } } ],
                 as: 'eng' } },
    { $lookup: { from: 'EntryTransferredLog',
                 let: { s: '$_id.SetupId', k: '$_id.key' },
                 pipeline: [ { $match: { $expr: { $and: [ { $eq: ['$SetupId', '$$s'] }, { $eq: ['$' + KEY, '$$k'] } ] } } },
                             { $sort: { CreatedAt: 1 } }, { $limit: 1 } ],
                 as: 'transferred' } },
    { $project: {
        final: 1, finals: 1,
        engines: { $ifNull: [{ $arrayElemAt: ['$eng.engines', 0] }, []] },
        transferredDoc: { $arrayElemAt: ['$transferred', 0] },
        shown:       { $ne: ['$final.AutoSuggestSource', 'NotSuggested'] },
        used:        { $gt: [{ $size: '$used' }, 0] },
        transferred: { $gt: [{ $size: '$transferred' }, 0] } } },
    { $addFields: {
        inOrder: { $and: ['$transferred', { $lt: ['$final.CreatedAt', '$transferredDoc.CreatedAt'] }] } } }
], { allowDiskUse: true }).toArray();

for (const l of lines) l.byPerson = l.engines.some(e => !STATIC.includes(e));

print('Bank lines with a final suggestion in the window: ' + lines.length);
print('');

// Count every combination of the four steps
const combos = {};
for (const l of lines) {
    const k = 'shown=' + l.shown + ' used=' + l.used + ' transferred=' + l.transferred + ' inOrder=' + !!l.inOrder + ' byPerson=' + l.byPerson;
    combos[k] = (combos[k] || 0) + 1;
}
print('Lines per combination of the five steps:');
Object.keys(combos).sort().forEach(k => print('  ' + String(combos[k]).padStart(6) + '  ' + k));
print('');

const usedNotSuggested = lines.filter(l => l.used && !l.shown).length;
const usedByAutomation = lines.filter(l => l.used && !l.byPerson).length;
const s3Candidates     = lines.filter(l => l.shown && l.used && l.transferred && l.inOrder && l.byPerson);
print('Used log but final suggestion NotSuggested (must NOT count as S3): ' + usedNotSuggested);
print('Used log from a StaticRules-only run, i.e. automation (NOT S3):    ' + usedByAutomation);
print('S3 candidates (shown, used, transferred after it, by a person):   ' + s3Candidates.length);
print('');

// Final suggestion engines and confidence, to see what users were shown
const bySource = {};
for (const l of lines) bySource[l.final.AutoSuggestSource] = (bySource[l.final.AutoSuggestSource] || 0) + 1;
print('Final suggestion source (AutoSuggestSource):');
Object.keys(bySource).forEach(k => print('  ' + String(bySource[k]).padStart(6) + '  ' + k));
print('');

// Side by side for up to 5 candidates: was the suggestion kept at transfer?
print('Up to 5 S3 candidates, final suggestion next to the transfer (compare entry type, party, invoices by hand):');
s3Candidates.slice(0, 5).forEach(l => {
    printjson({ line: l._id,
                suggestion: { source: l.final.AutoSuggestSource, confidence: l.final.Confidence,
                              entryType: l.final.EntryType, entryTypeValue: l.final.EntryTypeValue,
                              invoiceId: l.final.InvoiceId, amount: l.final.Amount, at: l.final.CreatedAt },
                transfer: l.transferredDoc });
});
if (s3Candidates.length === 0) print('  (none in this window)');
