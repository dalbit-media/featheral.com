const fs = require('fs');
const ts = require('./sites/world.featheral.com/play/node_modules/typescript');
const base = 'sites/world.featheral.com/play/server/';
const compact = s => s.replace(/\s+/g,' ').replace(/\s*([=,+?()])\s*/g,'$1').trim();
const rules = [];
function rule(sql, body) { rules.push([compact(sql), body]); }
function convert(file) {
  let source = fs.readFileSync(base+file+'.ts','utf8');
  const tree = ts.createSourceFile(file+'.ts',source,ts.ScriptTarget.Latest,true);
  const edits = [];
  function visit(n) {
    if(ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isCallExpression(n.expression.expression)) {
      const prepare = n.expression.expression;
      if(ts.isPropertyAccessExpression(prepare.expression) && prepare.expression.name.text === 'prepare') {
        const sql = prepare.arguments[0].getText(tree).slice(1,-1);
        const match = rules.find(([pattern]) => typeof pattern === 'string' ? pattern === compact(sql) : pattern.test(sql));
        if(match) {
          const db = prepare.expression.expression.getText(tree);
          const args = n.arguments.map(a=>a.getText(tree));
          const body = typeof match[1] === 'function' ? match[1](args,n.expression.name.text,sql) : match[1];
          const count = Math.max(args.length, ...[...body.matchAll(/\ba(\d+)\b/g)].map(m=>Number(m[1])+1), 0);
          const parameters=Array.from({length:count},(_,i)=>`a${i}: any`).join(', ');
          edits.push([n.getStart(tree),n.end,`((${parameters}) => ${body.replace(/\bDB\b/g,db)})(${args.join(', ')})`]); return;
        } else console.log(file+': '+sql.replace(/\s+/g,' '));
      }
    }
    ts.forEachChild(n,visit);
  }
  visit(tree);
  for(const [start,end,text] of edits.sort((a,b)=>b[0]-a[0]))source=source.slice(0,start)+text+source.slice(end);
  source=source.replace(/import (?:type )?\{ DatabaseSync \} from 'node:sqlite';/,"import { WorldDocuments } from './documents.ts';").replace(/\bDatabaseSync\b/g,'WorldDocuments');
  source=source.replace(/this\.db\.exec\('BEGIN IMMEDIATE'\)/g,'this.db.begin()').replace(/this\.db\.exec\('COMMIT'\)/g,'this.db.commit()').replace(/this\.db\.exec\('ROLLBACK'\)/g,'this.db.rollback()');
  fs.writeFileSync(base+file+'.ts',source);
}
const all = (table, sql) => rule(sql,`DB.all('${table}')`);
const find = (table,sql,predicate) => rule(sql,`DB.find('${table}', r => ${predicate})`);
const put = (table,sql,fields) => rule(sql,`DB.put('${table}', { ${fields} })`);
const update = (table,sql,predicate,body) => rule(sql,`({ changes: DB.update('${table}', r => ${predicate}, r => { ${body} }) })`);
const remove = (table,sql,predicate) => rule(sql,`DB.remove('${table}', r => ${predicate})`);
for(const sql of ['SELECT data FROM sessions WHERE id = ?', 'SELECT data FROM sessions WHERE id=?'])find('sessions',sql,'r.id === a0');
for(const sql of ['UPDATE sessions SET data = ? WHERE id = ?','UPDATE sessions SET data=? WHERE id=?'])update('sessions',sql,'r.id === a1','r.data = a0;');
for(const sql of ['UPDATE sessions SET expires=?,data = ? WHERE id = ?','UPDATE sessions SET expires=?,data=? WHERE id=?'])update('sessions',sql,'r.id === a2','r.expires = a0; r.data = a1;');
all('sessions','SELECT id,data FROM sessions');
all('market_pools','SELECT asset FROM market_pools');
all('market_pools','SELECT asset,dollars FROM market_pools');
update('public_totals','UPDATE public_totals SET metal = metal + ? WHERE id = 1','r.id === 1','r.metal += a0;');
update('public_totals','UPDATE public_totals SET dollars=dollars+? WHERE id=1','r.id === 1','r.dollars += a0;');
update('population_totals',"UPDATE population_totals SET total=total+? WHERE scope='global'","r.scope === 'global'",'r.total += a0;');
update('population_totals','UPDATE population_totals SET total=total+? WHERE scope=?','r.scope === a1','r.total += a0;');
update('market_pools','UPDATE market_pools SET units=units+?,dollars=dollars+? WHERE asset=?','r.asset === a2','r.units += a0; r.dollars += a1;');
update('market_pools','UPDATE market_pools SET units = ?, dollars = ? WHERE asset = ?','r.asset === a2','r.units = a0; r.dollars = a1;');
find('market_pools','SELECT units, dollars FROM market_pools WHERE asset = ?','r.asset === a0');
rule("SELECT COUNT(*) AS count FROM market_orders WHERE owner = ? AND status = 'open'",`({ count: DB.all('market_orders').filter(r => r.owner === a0 && r.status === 'open').length })`);
find('market_receipts','SELECT request, result FROM market_receipts WHERE owner = ? AND id = ?','r.owner === a0 && r.id === a1');
find('market_orders',"SELECT * FROM market_orders WHERE id = ? AND owner = ? AND status = 'open'","r.id === a0 && r.owner === a1 && r.status === 'open'");
update('market_orders',"UPDATE market_orders SET status = 'cancelled' WHERE id = ?",'r.id === a0',"r.status = 'cancelled';");
put('market_receipts','INSERT INTO market_receipts VALUES (?,?,?,?)','owner: a0, id: a1, request: a2, result: a3');
update('market_orders',"UPDATE market_orders SET remaining = remaining - ?, status = CASE WHEN remaining = ? THEN 'filled' ELSE 'open' END WHERE id = ?",'r.id === a2',"r.status = r.remaining === a1 ? 'filled' : 'open'; r.remaining -= a0;");
rule('INSERT INTO market_fills(asset,quantity,dollars,price,time,venue,buyer,seller) VALUES (?,?,?,?,?,?,?,?)',`DB.insert('market_fills', { asset: a0, quantity: a1, dollars: a2, price: a3, time: a4, venue: a5, buyer: a6, seller: a7 })`);
rule('INSERT INTO market_orders(owner,asset,side,price,quantity,remaining,status,createdAt) VALUES (?,?,?,?,?,?,?,?)',`DB.insert('market_orders', { owner: a0, asset: a1, side: a2, price: a3, quantity: a4, remaining: a5, status: a6, createdAt: a7 })`);
rule('SELECT price FROM market_fills WHERE asset = ? ORDER BY id DESC LIMIT 1',`DB.all('market_fills').filter(r => r.asset === a0).sort((a,b) => b.id-a.id)[0]`);
rule('SELECT id, asset, quantity, dollars, price, time, venue FROM market_fills WHERE asset = ? ORDER BY id DESC LIMIT 120',`DB.all('market_fills').filter(r => r.asset === a0).sort((a,b) => b.id-a.id).slice(0,120)`);
rule('SELECT * FROM market_fills WHERE buyer = ? OR seller = ? ORDER BY id DESC LIMIT 30',`DB.all('market_fills').filter(r => r.buyer === a0 || r.seller === a1).sort((a,b) => b.id-a.id).slice(0,30)`);
rule("SELECT * FROM market_orders WHERE owner = ? ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, id DESC LIMIT 100",`DB.all('market_orders').filter(r => r.owner === a0).sort((a,b) => Number(b.status === 'open')-Number(a.status === 'open') || b.id-a.id).slice(0,100)`);
rule("SELECT o.* FROM market_orders o JOIN sessions s ON s.id = o.owner WHERE o.asset = ? AND o.side = ? AND o.status = 'open' AND o.owner != ? AND s.expires > ? ORDER BY o.price ${side === 'sell' ? 'ASC' : 'DESC'}, o.id ASC",`DB.all('market_orders').filter(r => r.asset === a0 && r.side === a1 && r.status === 'open' && r.owner !== a2 && DB.find('sessions', s => s.id === r.owner && s.expires > a3)).sort((a,b) => (side === 'sell' ? a.price-b.price : b.price-a.price) || a.id-b.id)`);
rule("SELECT price, SUM(remaining) AS quantity FROM market_orders o JOIN sessions s ON s.id = o.owner WHERE asset = ? AND side = ? AND status = 'open' AND s.expires > ? GROUP BY price ORDER BY price ${side === 'buy' ? 'DESC' : 'ASC'} LIMIT 12",`[...DB.all('market_orders').filter(r => r.asset === a0 && r.side === a1 && r.status === 'open' && DB.find('sessions', s => s.id === r.owner && s.expires > a2)).reduce((levels: Map<number, number>, r) => levels.set(r.price, (levels.get(r.price) ?? 0) + r.remaining), new Map<number, number>())].map(([price, quantity]) => ({ price, quantity })).sort((a,b) => side === 'buy' ? b.price-a.price : a.price-b.price).slice(0,12)`);
for(const [fn,side] of [['MAX','buy'],['MIN','sell']])rule(`SELECT ${fn}(price) AS price FROM market_orders o JOIN sessions s ON s.id = o.owner WHERE asset = ? AND side = '${side}' AND status = 'open' AND s.expires > ?`,`({ price: DB.all('market_orders').filter(r => r.asset === a0 && r.side === '${side}' && r.status === 'open' && DB.find('sessions', s => s.id === r.owner && s.expires > a1)).sort((a,b) => ${side==='buy'?'b.price-a.price':'a.price-b.price'})[0]?.price ?? null })`);
rule('SELECT id,transaction_data FROM fund_commits WHERE settled=0 ORDER BY id',`DB.all('fund_commits').filter(r => r.settled === 0).sort((a,b) => a.id-b.id)`);
update('fund_commits','UPDATE fund_commits SET settled=1 WHERE id=?','r.id === a0','r.settled = 1;');
find('revoked_fund_sessions','SELECT 1 FROM revoked_fund_sessions WHERE token=?','r.token === a0');
find('session_aliases','SELECT owner FROM session_aliases WHERE token=?','r.token === a0');
put('revoked_fund_sessions','INSERT INTO revoked_fund_sessions VALUES(?)','token: a0');
remove('session_aliases','DELETE FROM session_aliases WHERE token=?','r.token === a0');
find('fund_wallets','SELECT address FROM fund_wallets WHERE owner=?','r.owner === a0');
find('world_fund_modes','SELECT 1 FROM world_fund_modes WHERE owner=?','r.owner === a0');
find('fund_wallets','SELECT owner FROM fund_wallets WHERE address=?','r.address === a0');
find('fund_pool_seeds','SELECT 1 FROM fund_pool_seeds WHERE asset=?','r.asset === a0');
update('market_pools','UPDATE market_pools SET units=units+? WHERE asset=?','r.asset === a1','r.units += a0;');
put('fund_pool_seeds','INSERT INTO fund_pool_seeds VALUES(?,?)','asset: a0, quantity: a1');
update('market_pools','UPDATE market_pools SET dollars=? WHERE asset=?','r.asset === a1','r.dollars = a0;');
rule("SELECT id,json_extract(data,'$.account.game.dollars') AS dollars FROM sessions",`DB.all('sessions').map(r => ({ id: r.id, dollars: JSON.parse(r.data).account.game.dollars }))`);
rule("SELECT owner,SUM(price*remaining) AS dollars FROM market_orders WHERE side='buy' AND status='open' GROUP BY owner",`[...DB.all('market_orders').filter(r => r.side === 'buy' && r.status === 'open').reduce((balances: Map<string, number>, r) => balances.set(r.owner, (balances.get(r.owner) ?? 0) + r.price*r.remaining), new Map<string, number>())].map(([owner, dollars]) => ({ owner, dollars }))`);
rule('INSERT INTO fund_commits(transaction_data) VALUES(?)',`({ lastInsertRowid: DB.insert('fund_commits', { transaction_data: a0, settled: 0 }) })`);
put('fund_wallets','INSERT INTO fund_wallets VALUES(?,?)','owner: a0, address: a1');
put('world_fund_modes','INSERT OR IGNORE INTO world_fund_modes VALUES(?)','owner: a0');
put('session_aliases','INSERT OR REPLACE INTO session_aliases VALUES(?,?)','token: a0, owner: a1');
rule('SELECT id,payload,message,payment,status,error,at FROM world_fund_requests WHERE owner=? ORDER BY at DESC LIMIT 50',`DB.all('world_fund_requests').filter(r => r.owner === a0).sort((a,b) => b.at-a.at).slice(0,50)`);
find('world_fund_requests','SELECT * FROM world_fund_requests WHERE owner=? AND id=?','r.owner === a0 && r.id === a1');
find('world_fund_requests','SELECT status FROM world_fund_requests WHERE owner=? AND id=?','r.owner === a0 && r.id === a1');
rule("SELECT COUNT(*) AS n FROM world_fund_requests WHERE owner=? AND status IN ('prepared','paying')",`({ n: DB.all('world_fund_requests').filter(r => r.owner === a0 && ['prepared','paying'].includes(r.status)).length })`);
rule("INSERT INTO world_fund_requests(owner,id,payload,payment,message,status,error,at) VALUES(?,?,?,?,?,'prepared',NULL,?) ON CONFLICT(owner,id) DO UPDATE SET payment=excluded.payment,message=excluded.message,error=NULL",`DB.put('world_fund_requests', { owner: a0, id: a1, payload: a2, status: 'prepared', at: a5, ...DB.find('world_fund_requests', r => r.owner === a0 && r.id === a1), payment: a3, message: a4, error: null })`);
for(const [sql,pred,body] of [
 ["UPDATE world_fund_requests SET status='cancelled' WHERE owner=? AND id=?", 'r.owner === a0 && r.id === a1', "r.status = 'cancelled';"],
 ["UPDATE world_fund_requests SET status='prepared',signature=NULL WHERE owner=? AND id=?", 'r.owner === a0 && r.id === a1', "r.status = 'prepared'; r.signature = null;"],
 ["UPDATE world_fund_requests SET status='paying',signature=? WHERE owner=? AND id=?", 'r.owner === a1 && r.id === a2', "r.status = 'paying'; r.signature = a0;"],
 ["UPDATE world_fund_requests SET status='complete',error=NULL WHERE owner=? AND id=?", 'r.owner === a0 && r.id === a1', "r.status = 'complete'; r.error = null;"],
 ['UPDATE world_fund_requests SET error=? WHERE owner=? AND id=?', 'r.owner === a1 && r.id === a2', 'r.error = a0;']
])update('world_fund_requests',sql,pred,body);
for(const sql of ['SELECT publicId, nickname, worldAddress FROM chat_profiles WHERE owner = ?', 'SELECT worldAddress FROM chat_profiles WHERE owner=?','SELECT * FROM chat_profiles WHERE owner = ?','SELECT lastMessageAt FROM chat_profiles WHERE owner = ?'])find('chat_profiles',sql,'r.owner === a0');
find('chat_profiles','SELECT owner FROM chat_profiles WHERE nameKey = ?','r.nameKey === a0');
find('chat_receipts','SELECT request, message FROM chat_receipts WHERE owner = ? AND requestId = ?','r.owner === a0 && r.requestId === a1');
put('chat_profiles','INSERT INTO chat_profiles(owner,publicId,nickname,nameKey,updatedAt,worldAddress) VALUES(?,?,?,?,?,?) ON CONFLICT(owner) DO UPDATE SET nickname=excluded.nickname,nameKey=excluded.nameKey,updatedAt=excluded.updatedAt,worldAddress=excluded.worldAddress',"...DB.find('chat_profiles', r => r.owner === a0), owner: a0, publicId: a1, nickname: a2, nameKey: a3, updatedAt: a4, worldAddress: a5");
put('chat_profiles','INSERT INTO chat_profiles (owner,publicId,nickname,nameKey,updatedAt) VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner) DO UPDATE SET nickname=excluded.nickname, nameKey=excluded.nameKey, updatedAt=excluded.updatedAt',"...DB.find('chat_profiles', r => r.owner === a0), owner: a0, publicId: a1, nickname: a2, nameKey: a3, updatedAt: a4");
update('chat_profiles','UPDATE chat_profiles SET worldAddress=NULL WHERE owner=?','r.owner === a0','r.worldAddress = null;');
update('chat_profiles','UPDATE chat_profiles SET lastMessageAt = ? WHERE owner = ?','r.owner === a1','r.lastMessageAt = a0;');
rule("SELECT * FROM (SELECT * FROM chat_messages WHERE room='global' ORDER BY id DESC LIMIT ?) ORDER BY id",`DB.all('chat_messages').filter(r => r.room === 'global').sort((a,b) => b.id-a.id).slice(0,a0).reverse()`);
rule('SELECT * FROM (SELECT * FROM chat_messages WHERE room=? ORDER BY id DESC LIMIT ?) ORDER BY id',`DB.all('chat_messages').filter(r => r.room === a0).sort((a,b) => b.id-a.id).slice(0,a1).reverse()`);
rule('INSERT INTO chat_messages (author,nickname,text,time,room) VALUES (?,?,?,?,?)',`({ lastInsertRowid: DB.insert('chat_messages', { author: a0, nickname: a1, text: a2, time: a3, room: a4 }) })`);
rule('INSERT INTO chat_receipts (owner,requestId,request,message,time) VALUES (?,?,?,?,?)',`DB.insert('chat_receipts', { owner: a0, requestId: a1, request: a2, message: a3, time: a4 }, 'sequence')`);
rule('DELETE FROM chat_messages WHERE room=? AND id NOT IN (SELECT id FROM chat_messages WHERE room=? ORDER BY id DESC LIMIT ?)',`DB.remove('chat_messages', r => r.room === a0 && !DB.all('chat_messages').filter(m => m.room === a1).sort((a,b) => b.id-a.id).slice(0,a2).some(m => m.id === r.id))`);
rule('DELETE FROM chat_receipts WHERE time < ? OR sequence NOT IN (SELECT sequence FROM chat_receipts ORDER BY sequence DESC LIMIT 4096)',`DB.remove('chat_receipts', r => r.time < a0 || !DB.all('chat_receipts').sort((a,b) => b.sequence-a.sequence).slice(0,4096).some(m => m.sequence === r.sequence))`);
remove('chat_profiles','DELETE FROM chat_profiles WHERE owner NOT IN (SELECT id FROM sessions WHERE expires > ?)',"!DB.find('sessions', s => s.id === r.owner && s.expires > a0)");
remove('chat_receipts','DELETE FROM chat_receipts WHERE time < ?','r.time < a0');
rule('SELECT count(*) AS total FROM sessions',`({ total: DB.all('sessions').length })`);
put('sessions','INSERT INTO sessions VALUES (?, ?, ?)','id: a0, expires: a1, data: a2');
update('public_totals','UPDATE public_totals SET settlements = settlements + ?, metal = metal + ? WHERE id = 1','r.id === 1','r.settlements += a0; r.metal += a1;');
rule("SELECT expires, json_extract(data, '$.csrf') AS csrf FROM sessions WHERE id = ?",`DB.all('sessions').filter(r => r.id === a0).map(r => ({ expires: r.expires, csrf: JSON.parse(r.data).csrf }))[0]`);
find('population_totals','SELECT total FROM population_totals WHERE scope = ?','r.scope === a0');
update('population_totals','UPDATE population_totals SET total = total + ? WHERE scope = ?','r.scope === a1','r.total += a0;');
put('population_totals','INSERT INTO population_totals VALUES (?, ?)','scope: a0, total: a1');
rule("SELECT settlements, metal, dollars+(SELECT COALESCE(SUM(dollars),0) FROM market_pools)+(SELECT COALESCE(SUM(price*remaining),0) FROM market_orders WHERE side='buy' AND status='open') AS supply, (SELECT total FROM population_totals WHERE scope = 'global') AS population FROM public_totals WHERE id = 1",`({ ...DB.find('public_totals', r => r.id === 1), supply: Number(DB.find('public_totals', r => r.id === 1)?.dollars ?? 0) + DB.all('market_pools').reduce((n,r) => n+r.dollars,0) + DB.all('market_orders').filter(r => r.side === 'buy' && r.status === 'open').reduce((n,r) => n+r.price*r.remaining,0), population: DB.find('population_totals', r => r.scope === 'global')?.total ?? 0 })`);
let store=fs.readFileSync(base+'store.ts','utf8');
const start=store.indexOf('  constructor(path:');
const end=store.indexOf('  create():',start);
store=store.slice(0,start)+`  constructor(domain: DomainDatabase, clock = Date.now, clockSpeed: ClockSpeed = 1, dollarFunds?: DollarFunds) {
    this.clock = clock;
    this.clockSpeed = clockSpeed;
    this.db = new WorldDocuments(domain);
    this.funds = dollarFunds ? new GameFunds(this.db, dollarFunds) : null;
    this.chat = new ChatArchive(this.db);
    this.chatDirectory = new ChatDirectoryStore(this.db);
    this.db.begin();
    try {
      this.exchange = new Exchange(this.db);
      enforceMonetaryPolicy(this.db);
      if (!this.db.find('population_totals', r => r.scope === 'global')) this.db.put('population_totals', { scope: 'global', total: 0 });
      if (!this.db.find('public_totals', r => r.id === 1)) this.db.put('public_totals', { id: 1, settlements: 0, metal: 0, dollars: 0 });
      const previous = this.db.find('server_clock', r => r.id === 1);
      this.realAnchor = this.clock();
      const latest = Math.max(0, ...this.db.all('sessions').map(row => (JSON.parse(row.data) as Session).account.updatedAt));
      this.serverAnchor = Math.max(latest, previous
        ? Number(previous.serverTime) + Math.max(0, this.realAnchor - Number(previous.realTime)) * Number(previous.speed)
        : this.realAnchor);
      this.lastServerTime = this.serverAnchor;
      this.serverNow(this.realAnchor);
      this.db.put('server_clock', { id: 1, realTime: this.realAnchor, serverTime: this.serverAnchor, speed: clockSpeed });
      for (const row of this.db.all('sessions')) {
        const session = JSON.parse(row.data) as Session;
        const before = JSON.stringify(session);
        migratePhysicalEconomy(session.account, this.serverAnchor);
        migrateEconomy(session.account, this.serverAnchor);
        initializeUpkeep(session.account, this.serverAnchor);
        inventory(session.account);
        if (before !== JSON.stringify(session)) this.db.put('sessions', { ...row, data: JSON.stringify(session) });
      }
      this.db.commit();
    } catch (error) {
      this.db.rollback();
      throw error;
    }
  }
`+store.slice(end);
store=store.replace('export class SqliteStore','export class DomainStore').replace("import { DatabaseSync } from 'node:sqlite';","import { WorldDocuments } from './documents.ts';\nimport type { DomainDatabase } from './documents.ts';").replace('private readonly db: DatabaseSync','private readonly db: WorldDocuments');
fs.writeFileSync(base+'store.ts',store);
convert('store');
