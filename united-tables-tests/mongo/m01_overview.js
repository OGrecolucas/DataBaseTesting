/* =====================================================================
   m01 · MongoDB overview of bankReconciliation
   Tests:   United Tables, section 7.1 (MongoDB):
            - which AutoSuggest collections exist in this env, how many
              documents they have and over which dates
            - whether EntryTransferredLog exists and has data: signal S3
              needs it (the suggestion must come before the transfer), and
              the export of 19.10 did not include it
            - the field names of each collection, to confirm the join keys
              (SetupId, BankEntryNumber, BankEntryId)
   Env:     staging Mongo (monolith cluster), database bankReconciliation (name set in DB_NAME).
            Needs the VPN (NoSplit) and the credentials from Spook.
   Run:     mongosh "<connection string>" --file mongo/m01_overview.js
            or paste it into the mongosh tab of MongoDB Compass.
   Runtime: seconds
   Safe:    read-only (counts and finds). Nothing is written.

   Expected
   - SuggestionLog, FinalSuggestionLog and AutoSuggestUsedLog have data.
   - EntryTransferredLog: if it is missing or empty, transfer a few bank
     lines that show a suggestion in this env, then run again. Remember the
     database is wiped on every deploy of the env.
   ===================================================================== */

const DB_NAME = 'bankReconciliation';  // database your Spook user can read (qa02: no -env suffix; see README)
const brdb = db.getSiblingDB(DB_NAME);

// The staging user may not list collections (listCollections), so every
// collection is read by name, and a read error is reported, not fatal.
const expected = ['SuggestionLog', 'FinalSuggestionLog', 'AutoSuggestUsedLog', 'EntryTransferredLog',
                  'EntrySavedLog', 'EntryBookedLog', 'EntryDeletedLog', 'BankReconciliationAccountChecksum'];
const counts = {};

print('Database: ' + brdb.getName());
print('');

for (const name of expected) {
    const coll = brdb.getCollection(name);
    let count = 0, first = null, last = null, keys = [];
    try {
        count = coll.countDocuments({});
        const a = coll.find({ CreatedAt: { $exists: true } }, { CreatedAt: 1 }).sort({ CreatedAt: 1 }).limit(1).toArray()[0];
        const z = coll.find({ CreatedAt: { $exists: true } }, { CreatedAt: 1 }).sort({ CreatedAt: -1 }).limit(1).toArray()[0];
        first = a ? a.CreatedAt : null;
        last = z ? z.CreatedAt : null;
        const sample = coll.findOne();
        keys = sample ? Object.keys(sample) : [];
    } catch (e) {
        print('NO ACCESS ' + name + '  (' + e.message + ')');
        continue;
    }
    counts[name] = count;
    print((count > 0 ? 'ok        ' : 'EMPTY     ') + name + '  documents: ' + count +
          '  from: ' + (first ? first.toISOString() : '-') + '  to: ' + (last ? last.toISOString() : '-'));
    print('          fields: ' + keys.join(', '));
}

print('');
print('EMPTY can also mean the collection does not exist: MongoDB returns 0 documents either way.');
const etl = counts['EntryTransferredLog'] || 0;
print(etl > 0
    ? 'S3 can be tested: EntryTransferredLog has ' + etl + ' documents. Run m02_s3_rule.js next.'
    : 'S3 cannot be tested yet: EntryTransferredLog is missing or empty in this env.');
