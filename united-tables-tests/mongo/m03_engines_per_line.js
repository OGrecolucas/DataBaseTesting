/* =====================================================================
   m03 · How many AutoSuggest log documents does one bank line produce?
   Tests:   United Tables, section 4 (performance) and 7.1 (MongoDB):
            - SuggestionLog documents per bank line, and per engine
              (VML, StaticRulesV2, CommonModel, FullTextSearch, ...).
              On qa02 (19.10) it was about 4 per line. This is the volume
              the daily run reads from Mongo for every bank line
            - which engines produce suggestions with a confidence above 0
   Env:     staging Mongo, database bankReconciliation (name set in DB_NAME). VPN (NoSplit).
   Run:     mongosh "<connection string>" --file mongo/m03_engines_per_line.js
   Runtime: seconds on staging
   Safe:    read-only (aggregate). Nothing is written.

   Expected
   - documents per line around 4 to 6. Much more means the daily run must
     read Mongo in small windows per SetupId.
   - engines with confidence > 0 exist; if every document has confidence 0
     (as on qa02), the env has no real suggestions and S3 cannot be tested.
   ===================================================================== */

const DB_NAME = 'bankReconciliation';  // database your Spook user can read (qa02: no -env suffix; see README)
const DAYS = 30;      // look-back window
const brdb = db.getSiblingDB(DB_NAME);
const FROM = new Date(Date.now() - DAYS * 24 * 3600 * 1000);

print('Database: ' + brdb.getName() + '   window: last ' + DAYS + ' days');

// 1. Documents per bank line
const perLine = brdb.SuggestionLog.aggregate([
    { $match: { CreatedAt: { $gte: FROM } } },
    { $group: { _id: { s: '$SetupId', n: '$BankEntryNumber', id: '$BankEntryId' }, docs: { $sum: 1 },
                engines: { $addToSet: '$AutoSuggestSource' } } },
    { $group: { _id: '$docs', lines: { $sum: 1 } } },
    { $sort: { _id: 1 } }
], { allowDiskUse: true }).toArray();

let lines = 0, docs = 0;
print('');
print('SuggestionLog documents per bank line:');
perLine.forEach(r => { lines += r.lines; docs += r._id * r.lines; print('  ' + String(r._id).padStart(3) + ' docs: ' + r.lines + ' lines'); });
print('Bank lines: ' + lines + '   documents: ' + docs + '   average per line: ' + (lines ? (docs / lines).toFixed(2) : '-'));

// 2. Per engine: how often it ran and how often it had some confidence
print('');
print('Per engine (AutoSuggestSource):');
brdb.SuggestionLog.aggregate([
    { $match: { CreatedAt: { $gte: FROM } } },
    { $group: { _id: '$AutoSuggestSource', docs: { $sum: 1 },
                withConfidence: { $sum: { $cond: [{ $gt: ['$Confidence', 0] }, 1, 0] } },
                withEntryType:  { $sum: { $cond: [{ $ne: [{ $ifNull: ['$EntryType', null] }, null] }, 1, 0] } },
                withInvoice:    { $sum: { $cond: [{ $ne: [{ $ifNull: ['$InvoiceId', null] }, null] }, 1, 0] } } } },
    { $sort: { docs: -1 } }
], { allowDiskUse: true }).forEach(r =>
    print('  ' + String(r._id).padEnd(16) + ' docs: ' + String(r.docs).padStart(6) +
          '  confidence>0: ' + String(r.withConfidence).padStart(6) +
          '  with entry type: ' + String(r.withEntryType).padStart(6) +
          '  with invoice: ' + String(r.withInvoice).padStart(6)));

// 3. What the user was finally shown
print('');
print('FinalSuggestionLog by AutoSuggestSource:');
brdb.FinalSuggestionLog.aggregate([
    { $match: { CreatedAt: { $gte: FROM } } },
    { $group: { _id: '$AutoSuggestSource', lines: { $sum: 1 } } },
    { $sort: { lines: -1 } }
]).forEach(r => print('  ' + String(r._id).padEnd(16) + ' ' + r.lines));
