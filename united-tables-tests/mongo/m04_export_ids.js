/* =====================================================================
   m04 · Export bank line ids from Mongo for the SQL join test
   Tests:   nothing by itself. It prints the (SetupId, BankEntryNumber,
            BankEntryId) of recent bank lines in the AutoSuggest logs, in
            the exact format of the VALUES list of
            sql/11_qa02_bank_entry_id.sql, so that file can check them
            against BankafstemningBank in the SQL database of the same env.
   Env:     staging Mongo, database bankReconciliation (name set in DB_NAME). VPN (NoSplit).
   Run:     mongosh "<connection string>" --file mongo/m04_export_ids.js
   Runtime: seconds
   Safe:    read-only (aggregate). Nothing is written.

   Use it when file 11 says "Id not found" (the env was redeployed after
   the export of 19.10), or to test another env.
   ===================================================================== */

const DB_NAME = 'bankReconciliation';  // database your Spook user can read (qa02: no -env suffix; see README)
const DAYS  = 30;      // look-back window
const LIMIT = 200;     // how many bank lines to print
const brdb  = db.getSiblingDB(DB_NAME);
const FROM  = new Date(Date.now() - DAYS * 24 * 3600 * 1000);

const rows = brdb.FinalSuggestionLog.aggregate([
    { $match: { CreatedAt: { $gte: FROM } } },
    { $group: { _id: { s: '$SetupId', n: '$BankEntryNumber', id: '$BankEntryId' } } },
    { $sort: { '_id.s': 1, '_id.n': 1 } },
    { $limit: LIMIT }
]).toArray();

print('-- ' + rows.length + ' bank lines from ' + brdb.getName() + ', paste into sql/11_qa02_bank_entry_id.sql:');
// BankEntryId is a NumberLong: toString() gives the plain number SQL needs
const plain = v => (v !== null && v !== undefined && typeof v.toString === 'function') ? v.toString() : String(v);
print(rows.map(r => '    (' + r._id.s + ', ' + r._id.n + ', ' + plain(r._id.id) + ')').join(',\n') + ';');
