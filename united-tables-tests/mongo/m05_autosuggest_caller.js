/* =====================================================================
   m05 · Who called AutoSuggest: a person on the screen, or bank automation?
   Tests:   United Tables, section 3, signal S3. Bank automation calls
            AutoSuggest too (to compute the paymentType of a rule), and the
            code logs those calls exactly like a person's, including an
            AutoSuggestUsedLog (isUserCall is true by default and automation
            does not change it). Without a code change, this script tells
            the two apart by the engines that ran:
            - screen:     the run has at least one non-static engine
                          (CommonModel always, VML / FullTextSearch /
                          VectorSearch by feature flag)
            - automation: the run has only StaticRulesV1 / V2
            It also ties each AutoSuggestUsedLog to the run just before it,
            so a "used" log written by automation is not read as a person
            using the suggestion.
   Env:     staging Mongo, database bankReconciliation (name set in DB_NAME). VPN (NoSplit).
   Run:     mongosh "<connection string>" --file mongo/m05_autosuggest_caller.js
   Runtime: seconds on staging
   Safe:    read-only (aggregate). Nothing is written.

   Second check, in SQL: the last output is a VALUES list for
   sql/12_workflow_autosuggest_check.sql, which looks for a
   BankEntryWorkflowStatus row next to each run. Automation runs should
   have one; screen runs should not.

   Expected
   - qa02 on 19.10 had only screen runs (every line had CommonModel), so
     "automation" will be 0 there. To see automation runs, use an env where
     a bank rule with the paymentType criterion ran on imported bank lines.
   - automation runs with an AutoSuggestUsedLog exist wherever automation
     runs: those are the logs S3 must ignore.
   ===================================================================== */

const DB_NAME   = 'bankReconciliation';  // database your Spook user can read (qa02: no -env suffix; see README)
const DAYS      = 30;     // look-back window
const RUN_MS    = 5000;   // engine logs of one run are written just before its FinalSuggestionLog
const USED_MS   = 10000;  // an AutoSuggestUsedLog follows its run within seconds
const STATIC    = ['StaticRulesV1', 'StaticRulesV2'];
const brdb = db.getSiblingDB(DB_NAME);
const FROM = new Date(Date.now() - DAYS * 24 * 3600 * 1000);

print('Database: ' + brdb.getName() + '   window: last ' + DAYS + ' days');

// One row per AutoSuggest run (= one FinalSuggestionLog), with its engines and its used log
const runs = brdb.FinalSuggestionLog.aggregate([
    { $match: { CreatedAt: { $gte: FROM } } },
    { $lookup: { from: 'SuggestionLog',
                 let: { s: '$SetupId', id: '$BankEntryId', t: '$CreatedAt' },
                 pipeline: [
                     { $match: { $expr: { $and: [
                         { $eq: ['$SetupId', '$$s'] }, { $eq: ['$BankEntryId', '$$id'] },
                         { $lte: ['$CreatedAt', '$$t'] }, { $gte: ['$CreatedAt', { $subtract: ['$$t', RUN_MS] }] } ] } } },
                     { $group: { _id: null, engines: { $addToSet: '$AutoSuggestSource' } } } ],
                 as: 'eng' } },
    { $lookup: { from: 'AutoSuggestUsedLog',
                 let: { s: '$SetupId', id: '$BankEntryId', t: '$CreatedAt' },
                 pipeline: [
                     { $match: { $expr: { $and: [
                         { $eq: ['$SetupId', '$$s'] }, { $eq: ['$BankEntryId', '$$id'] },
                         { $gte: ['$CreatedAt', '$$t'] }, { $lte: ['$CreatedAt', { $add: ['$$t', USED_MS] }] } ] } } },
                     { $limit: 1 } ],
                 as: 'used' } },
    { $project: { SetupId: 1, BankEntryNumber: 1, BankEntryId: 1, CreatedAt: 1, AutoSuggestSource: 1,
                  engines: { $ifNull: [{ $arrayElemAt: ['$eng.engines', 0] }, []] },
                  used: { $gt: [{ $size: '$used' }, 0] } } }
], { allowDiskUse: true }).toArray();

for (const r of runs) {
    r.caller = r.engines.length === 0 ? 'unknown (no engine logs)'
             : r.engines.every(e => STATIC.includes(e)) ? 'automation'
             : 'screen';
    r.shown = r.AutoSuggestSource !== 'NotSuggested';
}

// 1. Runs per caller, and how many have a used log and a real suggestion
print('');
print('AutoSuggest runs: ' + runs.length);
const table = {};
for (const r of runs) {
    const k = r.caller.padEnd(26) + ' used=' + String(r.used).padEnd(6) + ' shown=' + r.shown;
    table[k] = (table[k] || 0) + 1;
}
print('Runs per caller:');
Object.keys(table).sort().forEach(k => print('  ' + String(table[k]).padStart(6) + '  ' + k));

// 2. What it means for S3
const autoUsed   = runs.filter(r => r.caller === 'automation' && r.used).length;
const screenUsed = runs.filter(r => r.caller === 'screen' && r.used).length;
print('');
print('Used logs written by automation (S3 must ignore):     ' + autoUsed);
print('Used logs from a person on the screen (S3 may count): ' + screenUsed);

// 3. Engines seen per caller, to check the fingerprint
print('');
print('Engines per caller:');
['screen', 'automation', 'unknown (no engine logs)'].forEach(c => {
    const set = {};
    runs.filter(r => r.caller === c).forEach(r => r.engines.forEach(e => set[e] = (set[e] || 0) + 1));
    print('  ' + c.padEnd(26) + (Object.keys(set).length ? Object.entries(set).map(([e, n]) => e + ' ' + n).join(', ') : '-'));
});

// 4. VALUES list for sql/12_workflow_autosuggest_check.sql (up to 200 runs)
const plain = v => (v !== null && v !== undefined && typeof v.toString === 'function') ? v.toString() : String(v);
print('');
print('-- Paste into sql/12_workflow_autosuggest_check.sql:');
print(runs.slice(0, 200).map(r =>
    "    (" + r.SetupId + ", " + r.BankEntryNumber + ", " + plain(r.BankEntryId) + ", '" +
    r.CreatedAt.toISOString().replace('T', ' ').replace('Z', '') + "', '" +
    (r.caller.startsWith('unknown') ? 'unknown' : r.caller) + "', " + (r.used ? 1 : 0) + ")").join(',\n') + ';');
