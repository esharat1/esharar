const os = require('os');
process.env.UV_THREADPOOL_SIZE = String(os.cpus().length * 4);

const http  = require('http');
const https = require('https');
http.globalAgent.maxSockets  = Infinity;
https.globalAgent.maxSockets = Infinity;

// Agent مخصص لطلبات RPC: keepAlive: true يُعيد استخدام الاتصالات بين العناوين
// → يمنع تراكم الـ sockets (حل مشكلة التهنج) + يلغي TLS handshake لكل عنوان (أسرع)
const RPC_HTTP_AGENT  = new http.Agent ({ keepAlive: true, maxSockets: Infinity, maxFreeSockets: 256 });
const RPC_HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: Infinity, maxFreeSockets: 256 });

const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');
const { execSync } = require('child_process');
const CHAINS = require('./chains.json');

const API_KEY = 'e9491493-1318-4733-ad05-7b7776d27fa8';

// ─────────────────────────────────────────────
//  CoinStats — 5 مفاتيح (كل مفتاح يفحص عنواناً بالتوازي)
// القاعده المهمه استثناء شبكة سولانا وعدم اضافتها اطلاقا في الفحوصات التي تستخدم RPC ─────────────────────────────────────────────
const COINSTATS_BASE = 'https://openapiv1.coinstats.app';
const CS_ALL_KEYS = [
    'sf9q7fuypbzb4P19q/kQNmEbrU3GPZlSuY2lG4aDbiY=',
    'U8uIsZqRIOI+dFlnpU1PM1d9XwaeWe5kHsfMPwdFbsU=',
    'BufL+UzZwZu13f9BEv1JhV5fAXV2f8NLZ8a0iBrqMeE=',
    'oZVlgSnLFQPNrD43E6JDu8Fvr7ibKHRY8KElgoG5YAE=',
    '3GUc4ssH51hLJb7MO1euCdpGxFo6sTHwzaRiWrfMEcE=',
];

async function getActiveKeys() {
    const results = await Promise.all(CS_ALL_KEYS.map(async key => {
        try {
            await axios.get(`${COINSTATS_BASE}/portfolio/list`, {
                headers: { 'X-API-KEY': key }, timeout: 8000
            });
            return key;
        } catch (e) {
            // 401/403 = مفتاح منتهي أو غير صالح — استبعاد
            if (e.response?.status === 401 || e.response?.status === 403) return null;
            return key; // أي خطأ آخر يعني المفتاح صالح
        }
    }));
    return results.filter(k => k !== null);
}
const ADDRESSES_FILE = (() => {
    const p = require('path');
    const candidates = ['addresses.txt', 'addresses_only.txt'];
    for (const name of candidates) {
        const full = p.join(__dirname, name);
        if (require('fs').existsSync(full)) return full;
    }
    return p.join(__dirname, 'addresses.txt'); // fallback مع رسالة خطأ واضحة
})();

// تنسيق ذكي للأرقام — يعرض أرقاماً معنوية كافية بدون تدوين علمي
function fmt(num) {
    if (num === 0) return '0';
    if (num >= 1)          return num.toFixed(4);
    if (num >= 0.001)      return num.toFixed(6);
    if (num >= 0.000001)   return num.toFixed(8);
    return num.toFixed(10);
}

// ─────────────────────────────────────────────
//  COMMAND 1 — Token Balances via Enso API
// ─────────────────────────────────────────────
const ENSO_CHAINS = [1, 10, 8453, 42161];

async function checkTokenBalances(walletAddress) {
    let grandTotal = 0;
    const lines = [];

    // فحص كل الشبكات بالتوازي بدلاً من التسلسل
    const chainResults = await Promise.all(
        ENSO_CHAINS.map(async chainId => {
            try {
                const response = await axios.get('https://api.enso.build/api/v1/wallet/balances', {
                    params: { chainId, eoaAddress: walletAddress, useEoa: true },
                    headers: { Authorization: `Bearer ${API_KEY}` },
                    timeout: 10000
                });
                return { chainId, assets: response.data };
            } catch (_) {
                return { chainId, assets: null };
            }
        })
    );

    for (const { chainId, assets } of chainResults) {
        let chainTotal = 0;
        const chainLines = [];

        if (assets && assets.length > 0) {
            assets.forEach(asset => {
                const balance = asset.amount / Math.pow(10, asset.decimals);
                const usdValue = balance * asset.price;
                if (usdValue > 0.01) {
                    chainTotal += usdValue;
                    chainLines.push(`   - ${asset.symbol}: ${fmt(balance)} ($${usdValue.toFixed(2)})`);
                    chainLines.push(`     عنوان العقد: ${asset.address || asset.token || 'غير متوفر'}`);
                }
            });

            if (chainTotal > 0) {
                lines.push(`  [Chain ${chainId}] $${chainTotal.toFixed(2)}`);
                lines.push(...chainLines);
                grandTotal += chainTotal;
            }
        }
    }

    return { grandTotal, lines };
}

// ─────────────────────────────────────────────
//  COMMAND 2 — Open Positions via Free RPC
// ─────────────────────────────────────────────
const CHAIN_NAMES = { 1: 'Ethereum', 10: 'Optimism', 8453: 'Base', 42161: 'Arbitrum' };

const FREE_RPC = {
    1:     'https://ethereum.publicnode.com',
    10:    'https://optimism.publicnode.com',
    8453:  'https://base.publicnode.com',
    42161: 'https://arbitrum-one.publicnode.com'
};

// Protocols to check per chain
const DEFI_PROTOCOLS = [
    // ── Aave V3 ──
    { name: 'Aave V3',              chain: 1,     type: 'aave',  contract: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2' },
    { name: 'Aave V3',              chain: 10,    type: 'aave',  contract: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' },
    { name: 'Aave V3',              chain: 8453,  type: 'aave',  contract: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5' },
    { name: 'Aave V3',              chain: 42161, type: 'aave',  contract: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' },
    // ── Lido stETH (Ethereum only) ──
    { name: 'Lido stETH',           chain: 1,     type: 'erc20', contract: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', decimals: 18, symbol: 'stETH',  label: 'مركز Staking في Lido' },
    // ── Compound V3 ──
    { name: 'Compound V3 USDC',     chain: 1,     type: 'erc20', contract: '0xc3d688B66703497DAA19211EEdff47f25384cdc3', decimals: 6,  symbol: 'USDC',   label: 'مودع في Compound V3' },
    { name: 'Compound V3 USDC',     chain: 8453,  type: 'erc20', contract: '0xb125E6687d4313864e53df431d5425969c15Eb2', decimals: 6,  symbol: 'USDC',   label: 'مودع في Compound V3' },
    { name: 'Compound V3 USDC',     chain: 42161, type: 'erc20', contract: '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf', decimals: 6,  symbol: 'USDC',   label: 'مودع في Compound V3' },
    // ── Uniswap V3 LP NFTs ──
    { name: 'Uniswap V3 LP',        chain: 1,     type: 'nft',   contract: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88' },
    { name: 'Uniswap V3 LP',        chain: 10,    type: 'nft',   contract: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88' },
    { name: 'Uniswap V3 LP',        chain: 42161, type: 'nft',   contract: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88' },
    { name: 'Uniswap V3 LP',        chain: 8453,  type: 'nft',   contract: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f4' },
];

async function ethCall(chainId, contractAddress, calldata) {
    try {
        const response = await axios.post(FREE_RPC[chainId], {
            jsonrpc: '2.0',
            method: 'eth_call',
            params: [{ to: contractAddress, data: calldata }, 'latest'],
            id: 1
        }, { timeout: 8000 });
        return response.data.result;
    } catch (_) {
        return null;
    }
}

function decodeUint256(hex, slotIndex = 0) {
    if (!hex || hex === '0x') return 0n;
    const cleaned = hex.startsWith('0x') ? hex.slice(2) : hex;
    const slot = cleaned.slice(slotIndex * 64, (slotIndex + 1) * 64);
    if (!slot || slot.length < 64) return 0n;
    return BigInt('0x' + slot);
}

async function checkSingleProtocol(protocol, walletAddress) {
    const addrPad = walletAddress.toLowerCase().replace('0x', '').padStart(64, '0');

    if (protocol.type === 'aave') {
        // getUserAccountData(address) → selector: 0xbf92857c
        const result = await ethCall(protocol.chain, protocol.contract, '0xbf92857c' + addrPad);
        if (!result) return null;
        const totalCollateral = decodeUint256(result, 0);
        const totalDebt       = decodeUint256(result, 1);
        const collateralUSD   = Number(totalCollateral) / 1e8;
        const debtUSD         = Number(totalDebt) / 1e8;
        // تجاهل المراكز التي قيمتها أقل من $0.01
        if (collateralUSD + debtUSD < 0.01) return null;
        return {
            protocol: `${protocol.name} (${CHAIN_NAMES[protocol.chain]})`,
            details: `ضمانات: $${collateralUSD.toFixed(2)}  |  ديون: $${debtUSD.toFixed(2)}`
        };

    } else if (protocol.type === 'erc20') {
        // balanceOf(address) → selector: 0x70a08231
        const result = await ethCall(protocol.chain, protocol.contract, '0x70a08231' + addrPad);
        if (!result) return null;
        const balance = decodeUint256(result, 0);
        if (balance > 0n) {
            const amount = Number(balance) / Math.pow(10, protocol.decimals);
            if (amount > 0.001) {
                return {
                    protocol: `${protocol.name} (${CHAIN_NAMES[protocol.chain]})`,
                    details: `${protocol.label}: ${fmt(amount)} ${protocol.symbol}`
                };
            }
        }

    } else if (protocol.type === 'nft') {
        // balanceOf(address) → عدد مراكز LP
        const result = await ethCall(protocol.chain, protocol.contract, '0x70a08231' + addrPad);
        if (!result) return null;
        const count = decodeUint256(result, 0);
        if (count > 0n) {
            return {
                protocol: `${protocol.name} (${CHAIN_NAMES[protocol.chain]})`,
                details: `مركز سيولة مفتوح: ${count.toString()} مركز`
            };
        }
    }

    return null;
}

async function checkOpenPositions(walletAddress) {
    const results = await Promise.all(
        DEFI_PROTOCOLS.map(p => checkSingleProtocol(p, walletAddress))
    );
    return results.filter(r => r !== null);
}

// ─────────────────────────────────────────────
//  COMMAND 4 — CoinStats API (شامل)
// ─────────────────────────────────────────────

// الشبكات المدعومة لـ /wallet/balances (networks param)
const CS_NETWORKS = [
    'ethereum', 'optimism', 'base',     'arbitrum',
    'polygon',  'avalanche', 'binance',  'fantom',
    'cronos',   'harmony',  'moonbeam', 'celo',
    'klaytn',   'gnosis',   'linea',    'scroll',
    'zksync'
].join(',');

// دالة مساعدة: تُرجع البيانات، أو [] إن كان الرصيد فارغاً، أو null عند فشل الاتصال
async function fetchBalancesForAddress(address, key) {
    try {
        const r = await axios.get(`${COINSTATS_BASE}/wallet/balances`, {
            headers: { 'X-API-KEY': key },
            params:  { address, networks: CS_NETWORKS },
            timeout: 25000
        });
        return Array.isArray(r.data) ? r.data : [];
    } catch (_) { return null; }   // null = فشل الاتصال
}

async function fetchDefiForAddress(address, key) {
    try {
        const r = await axios.get(`${COINSTATS_BASE}/wallet/defi`, {
            headers: { 'X-API-KEY': key },
            params:  { address, connectionId: 'all' },
            timeout: 25000
        });
        return r.data?.protocols || [];
    } catch (_) { return null; }   // null = فشل الاتصال
}

// تشغيل دفعات متوازية مع كشف توقف الروابط الكاملة
async function runParallel(addresses, activeKeys, fetchFn) {
    const results     = [];
    const total       = addresses.length;
    const batchSize   = activeKeys.length;
    const failedKeys  = new Set();

    for (let i = 0; i < total; i += batchSize) {
        const batch = addresses.slice(i, i + batchSize);

        const batchResults = await Promise.all(
            batch.map((addr, j) => {
                process.stdout.write(`🔍 [${i + j + 1}/${total}] ${addr} ...\n`);
                return fetchFn(addr, activeKeys[j % activeKeys.length])
                    .then(data => ({ addr, data, keyIdx: j % activeKeys.length }));
            })
        );

        // تحقق من فشل كل المفاتيح في هذه الدفعة
        for (const { data, keyIdx } of batchResults) {
            if (data === null) failedKeys.add(keyIdx);
        }

        const allFailed = batchResults.every(r => r.data === null);

        if (allFailed) {
            // كل الروابط متعطلة — توقف فوري وحفظ المتبقي في Error.txt
            const unchecked = addresses.slice(i);
            const errFile   = require('path').join(__dirname, 'Error.txt');
            fs.writeFileSync(errFile,
                `=== عناوين لم يكتمل فحصها — ${new Date().toLocaleString()} ===\n` +
                `السبب: تعطّل جميع الروابط عند العنوان رقم ${i + 1}/${total}\n\n` +
                unchecked.join('\n') + '\n',
                'utf-8'
            );
            console.log(`\n⛔ تعطّلت جميع الروابط — تم إيقاف الفحص`);
            console.log(`📄 العناوين غير المفحوصة (${unchecked.length}): Error.txt`);
            return { results, aborted: true };
        }

        // إضافة ما نجح (data !== null)؛ من فشل يُسجَّل كـ []
        for (const { addr, data } of batchResults) {
            results.push({ address: addr, data: data ?? [] });
        }
    }

    return { results, aborted: false };
}

// ─────────────────────────────────────────────
//  COMMAND 4 — CoinStats: الأرصدة
// ─────────────────────────────────────────────
async function runCoinStatsBalances() {
    const OUTPUT_FILE = require('path').join(__dirname, 'results_cs_balances.txt');
    const out = (line) => { console.log(line); fs.appendFileSync(OUTPUT_FILE, line + '\n', 'utf-8'); };

    fs.writeFileSync(OUTPUT_FILE, `=== CoinStats — الأرصدة — ${new Date().toLocaleString()} ===\n\n`, 'utf-8');
    console.log(`\n📋 أمر 4 — CoinStats الأرصدة | 17 شبكة · كل التوكنات`);

    // اختبار المفاتيح
    process.stdout.write('🔑 اختبار المفاتيح... ');
    const activeKeys = await getActiveKeys();
    console.log(`${activeKeys.length}/${CS_ALL_KEYS.length} مفتاح صالح`);
    if (!activeKeys.length) { console.log('❌ لا توجد مفاتيح صالحة'); return; }

    const addresses = readAddresses();
    console.log(`📂 العناوين: ${addresses.length} | فحص ${activeKeys.length} بالتوازي\n`);

    // فحص متوازٍ
    const { results: rawResults, aborted: aborted4 } = await runParallel(addresses, activeKeys, fetchBalancesForAddress);
    if (aborted4 && rawResults.length === 0) return;

    // معالجة النتائج
    const addrResults = [];
    for (const { address, data } of rawResults) {
        const allTokens = [];
        let addrTotal = 0;
        for (const item of data) {
            const chainLabel = item.blockchain || item.chain || '?';
            for (const t of (item.balances || [])) {
                const balance  = Number(t.amount ?? t.balance ?? 0);
                const price    = Number(t.price ?? 0);
                const usdValue = balance * price;
                if (usdValue > 0.01) {
                    allTokens.push({ chainLabel, symbol: t.symbol || '?', balance, price, usdValue, contract: t.contractAddress || null });
                    addrTotal += usdValue;
                }
            }
        }
        if (allTokens.length > 0) {
            allTokens.sort((a, b) => b.usdValue - a.usdValue);
            addrResults.push({ address, addrTotal, allTokens });
        }
    }

    // ترتيب تنازلي حسب الرصيد الكلي
    addrResults.sort((a, b) => b.addrTotal - a.addrTotal);

    const grandTotal = addrResults.reduce((s, r) => s + r.addrTotal, 0);

    for (const { address, addrTotal, allTokens } of addrResults) {
        out(`${'─'.repeat(58)}`);
        out(`✅ ${address}`);
        out(`   الإجمالي: $${addrTotal.toFixed(2)}`);
        out(`\n   💰 الأرصدة (${allTokens.length} توكن):`);
        for (const t of allTokens) {
            const priceStr = t.price < 1 ? t.price.toFixed(6) : t.price.toFixed(2);
            let line = `      • [${t.chainLabel.padEnd(18)}] ${t.symbol.padEnd(10)} ${String(fmt(t.balance)).padStart(18)}  @$${priceStr.padStart(12)}  ≈ $${t.usdValue.toFixed(2)}`;
            if (t.contract) line += `\n        عقد: ${t.contract}`;
            out(line);
        }
        out('');
    }

    out(`${'═'.repeat(58)}`);
    out(`📊 الملخص: ${addrResults.length}/${addresses.length} لديه رصيد | الإجمالي: $${grandTotal.toFixed(2)}`);
    console.log(`\n✅ انتهى | ${addrResults.length}/${addresses.length} لديهم رصيد`);
    console.log(`📄 النتائج: ${OUTPUT_FILE}`);
}

// ─────────────────────────────────────────────
//  COMMAND 5 — CoinStats: المراكز المفتوحة
// ─────────────────────────────────────────────
async function runCoinStatsDefi() {
    const OUTPUT_FILE = require('path').join(__dirname, 'results_cs_defi.txt');
    const out = (line) => { console.log(line); fs.appendFileSync(OUTPUT_FILE, line + '\n', 'utf-8'); };

    fs.writeFileSync(OUTPUT_FILE, `=== CoinStats — المراكز المفتوحة — ${new Date().toLocaleString()} ===\n\n`, 'utf-8');
    console.log(`\n📋 أمر 5 — CoinStats المراكز المفتوحة | كل الشبكات`);

    // اختبار المفاتيح
    process.stdout.write('🔑 اختبار المفاتيح... ');
    const activeKeys = await getActiveKeys();
    console.log(`${activeKeys.length}/${CS_ALL_KEYS.length} مفتاح صالح`);
    if (!activeKeys.length) { console.log('❌ لا توجد مفاتيح صالحة'); return; }

    const addresses = readAddresses();
    console.log(`📂 العناوين: ${addresses.length} | فحص ${activeKeys.length} بالتوازي\n`);

    // فحص متوازٍ
    const { results: rawResults, aborted: aborted5 } = await runParallel(addresses, activeKeys, fetchDefiForAddress);
    if (aborted5 && rawResults.length === 0) return;

    // معالجة النتائج
    const addrResults = [];
    for (const { address, data } of rawResults) {
        const active = data.filter(p => Number(p.totalAssets?.USD ?? 0) > 0.01);
        if (!active.length) continue;
        active.sort((a, b) => Number(b.totalAssets?.USD ?? 0) - Number(a.totalAssets?.USD ?? 0));
        const addrTotal = active.reduce((s, p) => s + Number(p.totalAssets?.USD ?? 0), 0);
        addrResults.push({ address, addrTotal, protocols: active });
    }

    // ترتيب تنازلي حسب إجمالي المراكز
    addrResults.sort((a, b) => b.addrTotal - a.addrTotal);

    const grandTotal = addrResults.reduce((s, r) => s + r.addrTotal, 0);

    for (const { address, addrTotal, protocols } of addrResults) {
        out(`${'─'.repeat(58)}`);
        out(`✅ ${address}`);
        out(`   إجمالي المراكز: $${addrTotal.toFixed(2)}`);
        out(`\n   📌 المراكز المفتوحة (${protocols.length}):`);
        for (const proto of protocols) {
            const name     = proto.protocol || proto.name || 'بروتوكول';
            const chain    = proto.blockchain || proto.chain || '';
            const totalUSD = Number(proto.totalAssets?.USD ?? 0);
            out(`\n      ◆ ${name}${chain ? '  [' + chain + ']' : ''}  ≈ $${totalUSD.toFixed(2)}`);
            for (const asset of (proto.assets || proto.positions || [])) {
                const sym  = asset.symbol || asset.coin?.symbol || '?';
                const nm   = asset.name   || asset.coin?.name   || sym;
                const type = asset.type   || asset.category     || 'asset';
                const amt  = Number(asset.amount ?? asset.balance ?? 0);
                const val  = Number(asset.value  ?? asset.totalValue ?? 0);
                const apy  = asset.apy    ?? asset.apr           ?? null;
                let aLine  = `         - [${type}] ${sym} (${nm}): ${fmt(amt)}`;
                if (val > 0)       aLine += `  ≈ $${val.toFixed(2)}`;
                if (apy !== null)  aLine += `  APY: ${Number(apy).toFixed(2)}%`;
                out(aLine);
            }
        }
        out('');
    }

    out(`${'═'.repeat(58)}`);
    out(`📊 الملخص: ${addrResults.length}/${addresses.length} لديه مراكز | الإجمالي: $${grandTotal.toFixed(2)}`);
    console.log(`\n✅ انتهى | ${addrResults.length}/${addresses.length} لديهم مراكز مفتوحة`);
    console.log(`📄 النتائج: ${OUTPUT_FILE}`);
}

// ─────────────────────────────────────────────
//  SHARED: read addresses & run scan
// ─────────────────────────────────────────────
function readAddresses() {
    if (!fs.existsSync(ADDRESSES_FILE)) {
        console.error(`\n❌ الملف غير موجود: ${ADDRESSES_FILE}`);
        console.error(`   أنشئ الملف وضع فيه عنواناً واحداً في كل سطر.\n`);
        process.exit(1);
    }
    const raw = fs.readFileSync(ADDRESSES_FILE, 'utf-8')
        .split('\n').map(a => a.trim()).filter(a => a.length > 0);
    const seen = new Set();
    const unique = raw.filter(a => {
        const key = a.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    if (unique.length < raw.length)
        console.log(`⚠️  تم حذف ${raw.length - unique.length} عنوان مكرر (${raw.length} ← ${unique.length})`);
    return unique;
}

// ── حذف عنوان من ADDRESSES_FILE بعد الانتهاء من فحصه (دُفعات كل 20 عنوان) ──
const _pendingRemove = new Set();
let   _removeTimer   = null;
function scheduleRemoveAddress(addr) {
    _pendingRemove.add(addr.toLowerCase());
    if (!_removeTimer) {
        _removeTimer = setTimeout(() => {
            _removeTimer = null;
            flushRemoveAddresses();
        }, 1500);
    }
}
function flushRemoveAddresses() {
    if (!_pendingRemove.size) return;
    if (!fs.existsSync(ADDRESSES_FILE)) { _pendingRemove.clear(); return; }
    try {
        const lines    = fs.readFileSync(ADDRESSES_FILE, 'utf-8').split('\n');
        const filtered = lines.filter(l => !_pendingRemove.has(l.trim().toLowerCase()));
        fs.writeFileSync(ADDRESSES_FILE, filtered.join('\n'), 'utf-8');
    } catch (_) {}
    _pendingRemove.clear();
}
// تأكد من كتابة أي عناوين معلّقة عند خروج البرنامج
process.on('exit',     flushRemoveAddresses);
process.on('SIGINT',   () => { flushRemoveAddresses(); process.exit(0); });
process.on('SIGTERM',  () => { flushRemoveAddresses(); process.exit(0); });

// ─────────────────────────────────────────────
//  COMMAND 6 — OKX Web3 API: كل الأرصدة (EVM)
// ─────────────────────────────────────────────
const crypto = require('crypto');

const OKX_API_KEY    = 'e265e964-49bd-42f6-84c0-7977fa53195f';
const OKX_SECRET_KEY = 'E7157EEC9DC8AB5ACBE82B8905C843BF';
const OKX_PASSPHRASE = 'Zekoqaid1$$';

// أسماء جميع الشبكات — محمّلة من chains.json
const OKX_CHAIN_NAMES = CHAINS.okx.chain_names;

// ── 50 شبكة EVM الموحّدة — محمّلة من chains.json ──
const OKX_ALL_EVM_CHAINS = CHAINS.okx.evm_chains;

const OKX_ALL_CHAINS_STR = OKX_ALL_EVM_CHAINS.join(',');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Throttle عالمي: يُسلسل طلبات APIs ذات rate-limit ──
const _tq = {};
function throttled(key, fn, delayMs = 400) {
    if (!_tq[key]) _tq[key] = Promise.resolve();
    const r = _tq[key].then(() => fn());
    _tq[key] = r.catch(() => {}).then(() => sleep(delayMs));
    return r;
}

// ── شبكات الأمر 14 — محمّلة من chains.json ──
const CMD14_CHAINS = new Set(CHAINS.cmd14_chains);

function signOKX(timestamp, method, path, body = '') {
    const msg = timestamp + method + path + body;
    return crypto.createHmac('sha256', OKX_SECRET_KEY).update(msg).digest('base64');
}

// جلب رصيد عنوان واحد من سلسلة شبكات (مع إعادة محاولة)
async function fetchOKXBatch(walletAddress, chainsStr, retries = 3) {
    const apiPath = '/api/v5/wallet/asset/all-token-balances-by-address';
    const params  = `?address=${walletAddress}&chains=${chainsStr}`;
    for (let attempt = 0; attempt < retries; attempt++) {
        if (attempt > 0) await sleep(2500 * attempt);
        const ts  = new Date().toISOString();
        const sig = signOKX(ts, 'GET', apiPath + params);
        try {
            const r = await axios.get('https://www.okx.com' + apiPath + params, {
                headers: {
                    'OK-ACCESS-KEY':        OKX_API_KEY,
                    'OK-ACCESS-SIGN':       sig,
                    'OK-ACCESS-TIMESTAMP':  ts,
                    'OK-ACCESS-PASSPHRASE': OKX_PASSPHRASE,
                },
                timeout: 25000
            });
            if (r.data.code === '0' || r.data.code === 0)
                return r.data.data?.[0]?.tokenAssets || [];
            if (r.data.msg?.toLowerCase().includes('too many')) { await sleep(3000); continue; }
            return [];
        } catch (e) {
            const is429 = e.response?.status === 429 || e.response?.data?.msg?.toLowerCase().includes('too many');
            if (!is429 && attempt === retries - 1) break;
            if (is429) await sleep(3000 * (attempt + 1));
        }
    }
    return [];
}

// أمر 6: 50 شبكة EVM — طلب واحد مباشر (الحد الأقصى المدعوم من OKX)
async function fetchOKXBalances(walletAddress) {
    return fetchOKXBatch(walletAddress, OKX_ALL_CHAINS_STR);
}

async function runOKXBalances() {
    const OUTPUT_FILE = require('path').join(__dirname, 'results_okx_balances.txt');
    const out = (line) => { console.log(line); fs.appendFileSync(OUTPUT_FILE, line + '\n', 'utf-8'); };

    fs.writeFileSync(OUTPUT_FILE, `=== OKX Web3 — الأرصدة الكاملة — ${new Date().toLocaleString()} ===\n\n`, 'utf-8');
    console.log(`\n📋 أمر 6 — OKX Web3: الشبكات الرئيسية (${OKX_ALL_EVM_CHAINS.length} شبكة EVM · طلب واحد/عنوان)`);

    const addresses = readAddresses();
    console.log(`📂 العناوين: ${addresses.length}\n`);

    const addrResults = [];
    const total = addresses.length;

    for (let i = 0; i < total; i++) {
        const addr = addresses[i];
        if (i > 0) await sleep(900); // انتظار آمن بين الطلبات (rate limit: ~1 req/s)
        process.stdout.write(`🔍 [${i + 1}/${total}] ${addr} ...\n`);

        const tokens = await fetchOKXBalances(addr);

        const valuable = tokens.filter(t => {
            const bal   = parseFloat(t.balance   || 0);
            const price = parseFloat(t.tokenPrice || 0);
            return bal * price > 0.01;
        });

        if (valuable.length === 0) {
            console.log(`   ❌ لا رصيد`);
            continue;
        }

        const byChain = {};
        let addrTotal = 0;
        for (const t of valuable) {
            const chainName = OKX_CHAIN_NAMES[t.chainIndex] || `Chain ${t.chainIndex}`;
            const bal    = parseFloat(t.balance);
            const price  = parseFloat(t.tokenPrice);
            const usdVal = bal * price;
            addrTotal += usdVal;
            if (!byChain[chainName]) byChain[chainName] = [];
            byChain[chainName].push({ symbol: t.symbol, bal, price, usdVal, contract: t.tokenAddress || '' });
        }
        console.log(`   ✅ ${valuable.length} توكن | $${addrTotal.toFixed(2)}`);
        addrResults.push({ addr, addrTotal, byChain });
    }

    // ترتيب تنازلي
    addrResults.sort((a, b) => b.addrTotal - a.addrTotal);
    const grandTotal = addrResults.reduce((s, r) => s + r.addrTotal, 0);

    for (const { addr, addrTotal, byChain } of addrResults) {
        out(`${'─'.repeat(60)}`);
        out(`✅ ${addr}`);
        out(`   الإجمالي: $${addrTotal.toFixed(2)}`);

        // ترتيب الشبكات تنازلياً حسب إجمالي قيمتها
        const sortedChains = Object.entries(byChain)
            .map(([chainName, tokens]) => ({
                chainName,
                tokens: tokens.sort((a, b) => b.usdVal - a.usdVal),
                chainTotal: tokens.reduce((s, t) => s + t.usdVal, 0)
            }))
            .sort((a, b) => b.chainTotal - a.chainTotal);

        for (const { chainName, tokens, chainTotal } of sortedChains) {
            out(`\n   🔗 ${chainName}  ($${chainTotal.toFixed(2)})`);
            for (const t of tokens) {
                const priceStr = t.price < 1 ? t.price.toFixed(8) : t.price.toFixed(2);
                let line = `      • ${t.symbol.padEnd(12)} ${fmt(t.bal).padStart(20)}  @$${priceStr.padStart(14)}  ≈ $${t.usdVal.toFixed(2)}`;
                if (t.contract) line += `\n        عقد: ${t.contract}`;
                out(line);
            }
        }
        out('');
    }

    out(`${'═'.repeat(60)}`);
    out(`📊 الملخص: ${addrResults.length}/${addresses.length} لديه رصيد | الإجمالي: $${grandTotal.toFixed(2)}`);
    console.log(`\n✅ انتهى | ${addrResults.length}/${addresses.length} لديهم رصيد`);
    console.log(`📄 النتائج: ${OUTPUT_FILE}`);
}

// ─────────────────────────────────────────────
//  COMMAND 7 — اشتقاق العناوين من العبارات + فحص OKX
// ─────────────────────────────────────────────
const KEYS_FILE  = path.join(__dirname, 'keys.txt');
const ERROR_FILE = path.join(__dirname, 'error.txt');
const END_FILE   = path.join(__dirname, 'End.txt');
const ZIP_FILE   = path.join(__dirname, 'err_end.zip');

// ── تحديث err_end.zip بعد كل كتابة على error.txt أو End.txt ──
function updateErrEndZip() {
    try {
        const files = [ERROR_FILE, END_FILE].filter(f => fs.existsSync(f));
        if (files.length === 0) return;
        const fileArgs = files.map(f => `'${f}'`).join(', ');
        execSync(
            `python3 -c "import zipfile,os; z=zipfile.ZipFile('${ZIP_FILE}','w',zipfile.ZIP_DEFLATED);\n` +
            `[z.write(f,os.path.basename(f)) for f in [${fileArgs}] if os.path.exists(f)]; z.close()"`,
            { stdio: 'ignore' }
        );
    } catch (_) {}
}

// ── تسجيل فوري للأخطاء ──
function logError(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    console.error(`⚠️  ${line}`);
    fs.appendFileSync(ERROR_FILE, line + '\n', 'utf-8');
    updateErrEndZip();
}

// SLIP-0010 Ed25519 لاشتقاق مفاتيح Solana
function slip10Ed25519(seed, path) {
    const segs = path.replace('m/', '').split('/').map(s =>
        parseInt(s) + (s.includes("'") ? 0x80000000 : 0)
    );
    let h  = crypto.createHmac('sha512', Buffer.from('ed25519 seed')).update(seed).digest();
    let kL = h.slice(0, 32), kR = h.slice(32);
    for (const idx of segs) {
        const d = Buffer.alloc(37);
        d[0] = 0x00;
        kL.copy(d, 1);
        d.writeUInt32BE(idx >>> 0, 33);
        const c = crypto.createHmac('sha512', kR).update(d).digest();
        kL = c.slice(0, 32);
        kR = c.slice(32);
    }
    return kL;
}

// اشتقاق عنوانين (index 0 و 1) لكل شبكة من مفتاح واحد
function deriveAddresses(mnemonic) {
    const { sha256 }             = require('@noble/hashes/sha2');
    const { keccak_256 }         = require('@noble/hashes/sha3');
    const { ripemd160 }          = require('@noble/hashes/legacy');
    const { secp256k1 }          = require('@noble/curves/secp256k1');
    const { HDKey }              = require('@scure/bip32');
    const { mnemonicToSeedSync } = require('@scure/bip39');
    const { bech32, bech32m }    = require('@scure/base');
    const bs58checkRaw           = require('bs58check');
    const bs58check              = bs58checkRaw.default || bs58checkRaw;

    const seed = Buffer.from(mnemonicToSeedSync(mnemonic));
    const root = HDKey.fromMasterSeed(seed);
    const entries = [];

    for (const i of [0]) {
        // ── Bitcoin Native SegWit (bc1q) ──
        const bk   = root.derive(`m/84'/0'/0'/0/${i}`);
        const bh16 = ripemd160(sha256(bk.publicKey));
        const btc  = bech32.encode('bc', [0, ...bech32.toWords(Buffer.from(bh16))]);
        entries.push({ type: 'BTC', label: 'Bitcoin', index: i, addr: btc, chainIndex: '0' });

        // ── Bitcoin Taproot (bc1p) ──
        const tk2   = root.derive(`m/86'/0'/0'/0/${i}`);
        const xonly = tk2.publicKey.slice(1);
        const tap   = bech32m.encode('bc', [1, ...bech32m.toWords(xonly)]);
        entries.push({ type: 'BTC-TAP', label: 'Bitcoin-Taproot', index: i, addr: tap, chainIndex: '0' });

        // ── TRON ──
        const tk  = root.derive(`m/44'/195'/0'/0/${i}`);
        const tu  = secp256k1.getPublicKey(tk.privateKey, false).slice(1);
        const th  = keccak_256(tu);
        const tb  = new Uint8Array(21); tb[0] = 0x41; tb.set(th.slice(-20), 1);
        entries.push({ type: 'TRX', label: 'TRON', index: i, addr: bs58check.encode(tb), chainIndex: '195' });

        // ── Litecoin ──
        const lk  = root.derive(`m/44'/2'/0'/0/${i}`);
        const lh  = ripemd160(sha256(lk.publicKey));
        const lb  = new Uint8Array(21); lb[0] = 0x30; lb.set(lh, 1);
        entries.push({ type: 'LTC', label: 'Litecoin', index: i, addr: bs58check.encode(lb), chainIndex: '2' });

        // ── Dogecoin ──
        const dk  = root.derive(`m/44'/3'/0'/0/${i}`);
        const dh  = ripemd160(sha256(dk.publicKey));
        const db  = new Uint8Array(21); db[0] = 0x1e; db.set(dh, 1);
        entries.push({ type: 'DOGE', label: 'Dogecoin', index: i, addr: bs58check.encode(db), chainIndex: '3' });

        // ── Dash ──
        const dashk = root.derive(`m/44'/5'/0'/0/${i}`);
        const dashh = ripemd160(sha256(dashk.publicKey));
        const dashb = new Uint8Array(21); dashb[0] = 0x4C; dashb.set(dashh, 1);
        entries.push({ type: 'DASH', label: 'Dash', index: i, addr: bs58check.encode(dashb), chainIndex: '5' });

        // ── Bitcoin Cash (BCH) ──
        const bchk = root.derive(`m/44'/145'/0'/0/${i}`);
        const bchh = ripemd160(sha256(bchk.publicKey));
        const bchb = new Uint8Array(21); bchb[0] = 0x00; bchb.set(bchh, 1);
        entries.push({ type: 'BCH', label: 'Bitcoin-Cash', index: i, addr: bs58check.encode(bchb), chainIndex: '145' });

        // ── SUI ──
        const { blake2b } = require('@noble/hashes/blake2');
        const { ed25519 } = require('@noble/curves/ed25519');
        const suiPriv = slip10Ed25519(seed, `m/44'/784'/0'/0'/${i}'`);
        const suiPub  = ed25519.getPublicKey(suiPriv);
        const suiInput = new Uint8Array([0x00, ...suiPub]);
        const suiHash  = blake2b(suiInput, { dkLen: 32 });
        const suiAddr  = '0x' + Buffer.from(suiHash).toString('hex');
        entries.push({ type: 'SUI', label: 'SUI', index: i, addr: suiAddr, chainIndex: '784' });
    }

    return entries;
}

// معرّفات EVM الـ 50 (لاستثنائها عند جلب الشبكات غير EVM)
const OKX_EVM_IDS = new Set([
    '1','10','56','100','137','250','324','1101','1284',
    '8453','25','42161','42220','43114','59144','81457','534352',
    '61','14','8217','321','1088','288','1313161554','2020','1285',
    '10001','1116','42170','1030','648','2222','369','5000','204',
    '11155111','11235','169','1111','4200','13371','196','167000',
    '60808','34443','223','200901','1625','94168','143',
]);

// جلب كل الشبكات غير EVM وغير SOL من OKX API ديناميكياً
async function fetchNonEvmSolChains() {
    const apiPath = '/api/v5/wallet/chain/supported-chains';
    const ts  = new Date().toISOString();
    const sig = signOKX(ts, 'GET', apiPath);
    try {
        const r = await axios.get('https://www.okx.com' + apiPath, {
            headers: {
                'OK-ACCESS-KEY':        OKX_API_KEY,
                'OK-ACCESS-SIGN':       sig,
                'OK-ACCESS-TIMESTAMP':  ts,
                'OK-ACCESS-PASSPHRASE': OKX_PASSPHRASE,
            },
            timeout: 15000
        });
        if (r.data.code === '0' || r.data.code === 0) {
            const ids = (r.data.data || [])
                .map(c => String(c.chainIndex ?? ''))
                .filter(id => id && !OKX_EVM_IDS.has(id) && id !== '501');
            if (ids.length > 0) return ids;
        }
    } catch (_) {}
    // fallback ثابت في حال تعذّر الاتصال
    return ['0','2','3','5','14','61','145','195','204','223','288','321',
            '369','648','784','1030','1088','1111','1116','1285','1313161554',
            '1625','2020','2222','4200','5000','7000','8217','9745','10001',
            '11235','13371','34443','42170','60808','94168','143','146',
            '167000','196','200901'];
}

// فحص عنوان واحد عبر OKX بقائمة شبكات مخصصة
async function fetchOKXSingle(addr, chainsStr) {
    const apiPath = '/api/v5/wallet/asset/all-token-balances-by-address';
    const params  = `?address=${addr}&chains=${chainsStr}`;
    const ts      = new Date().toISOString();
    const sig     = signOKX(ts, 'GET', apiPath + params);
    try {
        const r = await axios.get('https://www.okx.com' + apiPath + params, {
            headers: {
                'OK-ACCESS-KEY':        OKX_API_KEY,
                'OK-ACCESS-SIGN':       sig,
                'OK-ACCESS-TIMESTAMP':  ts,
                'OK-ACCESS-PASSPHRASE': OKX_PASSPHRASE,
            },
            timeout: 20000
        });
        if (r.data.code === '0' || r.data.code === 0)
            return r.data.data?.[0]?.tokenAssets || [];
        return [];
    } catch (_) { return []; }
}

// BTC (SegWit + Taproot) عبر Blockstream — مع إعادة محاولة واحدة
async function fetchBTCBalance(addr) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const r = await axios.get(`https://blockstream.info/api/address/${addr}`, { timeout: 5000 });
            const sat = r.data.chain_stats.funded_txo_sum - r.data.chain_stats.spent_txo_sum;
            return { sat, txCount: r.data.chain_stats.tx_count };
        } catch (_) { if (attempt === 0) await sleep(500); }
    }
    return null;
}

// LTC / DOGE عبر BlockCypher — مع إعادة محاولة واحدة
async function fetchBlockcypherBalance(addr, coin) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const r = await axios.get(
                `https://api.blockcypher.com/v1/${coin}/main/addrs/${addr}/balance`,
                { timeout: 5000 }
            );
            return { sat: r.data.final_balance, txCount: r.data.n_tx };
        } catch (_) { if (attempt === 0) await sleep(500); }
    }
    return null;
}

// جلب أسعار BTC/LTC/DOGE/DASH/BCH من OKX العام
async function fetchUTXOPrices() {
    const coins = { BTC: 'BTC-USDT', LTC: 'LTC-USDT', DOGE: 'DOGE-USDT', DASH: 'DASH-USDT', BCH: 'BCH-USDT' };
    const prices = { BTC: 95000, LTC: 90, DOGE: 0.08, DASH: 30, BCH: 400 }; // fallback
    try {
        await Promise.all(Object.entries(coins).map(async ([sym, instId]) => {
            const r = await axios.get(
                `https://www.okx.com/api/v5/market/ticker?instId=${instId}`,
                { timeout: 8000 }
            );
            const p = parseFloat(r.data.data?.[0]?.last || 0);
            if (p > 0) prices[sym] = p;
        }));
    } catch (_) {}
    return prices;
}

// فحص عنوان واحد وإعادة { tokens, hasActivity }
// chainsStr = كل الشبكات غير EVM/SOL مفصولة بفاصلة (مُمرَّرة من runSeedScan)
async function checkEntry(entry, chainsStr, prices = {}) {
    // ── BTC Native SegWit / Taproot — Blockstream للرصيد الأصلي + OKX للشبكات الأخرى ──
    if (entry.type === 'BTC' || entry.type === 'BTC-TAP') {
        const [btcRes, okxRaw] = await Promise.all([
            fetchBTCBalance(entry.addr),
            fetchOKXSingle(entry.addr, entry.chainIndex),
        ]);
        const tokens = okxRaw.filter(t =>
            parseFloat(t.balance || 0) * parseFloat(t.tokenPrice || 0) > 0.01
        );
        if (btcRes) {
            const bal = btcRes.sat / 1e8;
            const usd = bal * (prices.BTC || 95000);
            if (usd > 0.01 && !tokens.some(t => t.symbol === 'BTC' && t.chainIndex === '0')) {
                tokens.unshift({
                    balance: bal.toString(), tokenPrice: (prices.BTC || 95000).toString(),
                    symbol: 'BTC', tokenAddress: '', chainIndex: '0'
                });
            }
            return { tokens, hasActivity: btcRes.txCount > 0 || okxRaw.length > 0 };
        }
        return { tokens, hasActivity: okxRaw.length > 0 };
    }

    // ── Litecoin — BlockCypher للرصيد الأصلي + OKX للشبكات الأخرى ──
    if (entry.type === 'LTC') {
        const [ltcRes, okxRaw] = await Promise.all([
            fetchBlockcypherBalance(entry.addr, 'ltc'),
            fetchOKXSingle(entry.addr, entry.chainIndex),
        ]);
        const tokens = okxRaw.filter(t =>
            parseFloat(t.balance || 0) * parseFloat(t.tokenPrice || 0) > 0.01
        );
        if (ltcRes) {
            const bal = ltcRes.sat / 1e8;
            const usd = bal * (prices.LTC || 90);
            if (usd > 0.01 && !tokens.some(t => t.symbol === 'LTC' && t.chainIndex === '2')) {
                tokens.unshift({
                    balance: bal.toString(), tokenPrice: (prices.LTC || 90).toString(),
                    symbol: 'LTC', tokenAddress: '', chainIndex: '2'
                });
            }
            return { tokens, hasActivity: ltcRes.txCount > 0 || okxRaw.length > 0 };
        }
        return { tokens, hasActivity: okxRaw.length > 0 };
    }

    // ── Dogecoin — BlockCypher للرصيد الأصلي + OKX للشبكات الأخرى ──
    if (entry.type === 'DOGE') {
        const [dogeRes, okxRaw] = await Promise.all([
            fetchBlockcypherBalance(entry.addr, 'doge'),
            fetchOKXSingle(entry.addr, entry.chainIndex),
        ]);
        const tokens = okxRaw.filter(t =>
            parseFloat(t.balance || 0) * parseFloat(t.tokenPrice || 0) > 0.01
        );
        if (dogeRes) {
            const bal = dogeRes.sat / 1e8;
            const usd = bal * (prices.DOGE || 0.08);
            if (usd > 0.01 && !tokens.some(t => t.symbol === 'DOGE' && t.chainIndex === '3')) {
                tokens.unshift({
                    balance: bal.toString(), tokenPrice: (prices.DOGE || 0.08).toString(),
                    symbol: 'DOGE', tokenAddress: '', chainIndex: '3'
                });
            }
            return { tokens, hasActivity: dogeRes.txCount > 0 || okxRaw.length > 0 };
        }
        return { tokens, hasActivity: okxRaw.length > 0 };
    }

    // ── Dash — BlockCypher للرصيد الأصلي + OKX للشبكات الأخرى ──
    if (entry.type === 'DASH') {
        const [dashRes, okxRaw] = await Promise.all([
            fetchBlockcypherBalance(entry.addr, 'dash'),
            fetchOKXSingle(entry.addr, entry.chainIndex),
        ]);
        const tokens = okxRaw.filter(t =>
            parseFloat(t.balance || 0) * parseFloat(t.tokenPrice || 0) > 0.01
        );
        if (dashRes) {
            const bal = dashRes.sat / 1e8;
            const usd = bal * (prices.DASH || 30);
            if (usd > 0.01 && !tokens.some(t => t.symbol === 'DASH' && t.chainIndex === '5')) {
                tokens.unshift({
                    balance: bal.toString(), tokenPrice: (prices.DASH || 30).toString(),
                    symbol: 'DASH', tokenAddress: '', chainIndex: '5'
                });
            }
            return { tokens, hasActivity: dashRes.txCount > 0 || okxRaw.length > 0 };
        }
        return { tokens, hasActivity: okxRaw.length > 0 };
    }

    // ── Bitcoin Cash — BlockCypher للرصيد الأصلي + OKX للشبكات الأخرى ──
    if (entry.type === 'BCH') {
        const [bchRes, okxRaw] = await Promise.all([
            fetchBlockcypherBalance(entry.addr, 'bch'),
            fetchOKXSingle(entry.addr, entry.chainIndex),
        ]);
        const tokens = okxRaw.filter(t =>
            parseFloat(t.balance || 0) * parseFloat(t.tokenPrice || 0) > 0.01
        );
        if (bchRes) {
            const bal = bchRes.sat / 1e8;
            const usd = bal * (prices.BCH || 400);
            if (usd > 0.01 && !tokens.some(t => t.symbol === 'BCH' && t.chainIndex === '145')) {
                tokens.unshift({
                    balance: bal.toString(), tokenPrice: (prices.BCH || 400).toString(),
                    symbol: 'BCH', tokenAddress: '', chainIndex: '145'
                });
            }
            return { tokens, hasActivity: bchRes.txCount > 0 || okxRaw.length > 0 };
        }
        return { tokens, hasActivity: okxRaw.length > 0 };
    }

    // ── SUI — OKX فقط (لا يوجد API عام مجاني موثوق) ──
    if (entry.type === 'SUI') {
        const okxRaw = await fetchOKXSingle(entry.addr, entry.chainIndex);
        const tokens = okxRaw.filter(t =>
            parseFloat(t.balance || 0) * parseFloat(t.tokenPrice || 0) > 0.01
        );
        return { tokens, hasActivity: okxRaw.length > 0 };
    }

    // ── TRX وكل الأنواع الأخرى — شبكة العنوان الخاصة فقط عبر OKX ──
    const raw = await fetchOKXSingle(entry.addr, entry.chainIndex);
    const tokens = raw.filter(t =>
        parseFloat(t.balance || 0) * parseFloat(t.tokenPrice || 0) > 0.01
    );
    return { tokens, hasActivity: raw.length > 0 };
}

// ─────────────────────────────────────────────
//  مساعد: استخراج عبارة BIP39 من سطر قد يحتوي نصوصاً زائدة
//  يأخذ أول 24 أو 12 كلمة أبجدية ويتجاهل ما بعدها (فواصل، عناوين، إلخ)
// ─────────────────────────────────────────────
function extractMnemonicWords(line) {
    const tokens = line.split(/[\s,;|،\t]+/)
        .map(w => w.replace(/[^a-zA-Z]/g, '').toLowerCase())
        .filter(w => w.length >= 3 && w.length <= 10 && /^[a-z]+$/.test(w));
    if (tokens.length >= 24) return tokens.slice(0, 24).join(' ');
    if (tokens.length >= 12) return tokens.slice(0, 12).join(' ');
    return null;
}

// ─────────────────────────────────────────────
//  نقل العبارة المنتهية من keys.txt إلى End.txt
// ─────────────────────────────────────────────
function moveToEnd(mnemonic) {
    try {
        // إضافة العبارة إلى End.txt فوراً
        fs.appendFileSync(END_FILE, mnemonic + '\n', 'utf-8');
        updateErrEndZip();
        // حذف العبارة من keys.txt
        if (fs.existsSync(KEYS_FILE)) {
            const lines = fs.readFileSync(KEYS_FILE, 'utf-8').split('\n');
            const filtered = lines.filter(l => extractMnemonicWords(l.trim()) !== mnemonic);
            fs.writeFileSync(KEYS_FILE, filtered.join('\n'), 'utf-8');
        }
    } catch (e) {
        console.error(`⚠️  خطأ أثناء نقل العبارة إلى End.txt: ${e.message}`);
    }
}

async function runSeedScan() {
    const OUTPUT_FILE = require('path').join(__dirname, 'results_seeds.txt');
    const out = (line) => { console.log(line); fs.appendFileSync(OUTPUT_FILE, line + '\n', 'utf-8'); };

    fs.writeFileSync(OUTPUT_FILE, `=== فحص العبارات — ${new Date().toLocaleString()} ===\n\n`, 'utf-8');
    console.log(`\n📋 أمر 7 — اشتقاق العناوين وفحص الأرصدة`);
    console.log(`   الشبكات: BTC (SegWit+Taproot) · TRX · LTC · DOGE + كل شبكات OKX غير EVM/SOL\n`);

    // ── قراءة وتحقق من العبارات ──
    const { validateMnemonic } = require('@scure/bip39');
    const { wordlist }         = require('@scure/bip39/wordlists/english');
    const rawLines = fs.readFileSync(KEYS_FILE, 'utf-8')
        .split('\n').map(l => l.trim()).filter(l => l.length > 0);

    // استخراج العبارة من كل سطر — يتجاهل النصوص الزائدة بعد الكلمات الـ12 أو 24
    const mnemonics = rawLines
        .map(line => extractMnemonicWords(line))
        .filter(mn => mn !== null && validateMnemonic(mn, wordlist));

    console.log(`📂 العبارات: ${mnemonics.length} من أصل ${rawLines.length} سطر\n`);
    if (!mnemonics.length) { console.log('❌ لا توجد عبارات صالحة'); return; }

    // تصحيح تلقائي للكلمات المبتورة أو المكتوبة بشكل خاطئ
    function correctMnemonic(mn) {
        const words    = mn.split(/\s+/);
        const fixed    = [];
        const changes  = [];
        for (const word of words) {
            if (wordlist.includes(word)) {
                fixed.push(word);
            } else {
                // بحث بالبادئة أولاً
                const byPrefix = wordlist.filter(w => w.startsWith(word));
                if (byPrefix.length === 1) {
                    fixed.push(byPrefix[0]);
                    changes.push(`${word}→${byPrefix[0]}`);
                } else {
                    // بحث بمسافة تحرير 1 (استبدال/حذف/إضافة حرف واحد)
                    const byEdit = wordlist.filter(w => {
                        if (Math.abs(w.length - word.length) > 1) return false;
                        let diff = 0;
                        if (w.length === word.length) {
                            for (let i = 0; i < w.length; i++) if (w[i] !== word[i]) diff++;
                            return diff === 1;
                        }
                        const [longer, shorter] = w.length > word.length ? [w, word] : [word, w];
                        let si = 0, li = 0;
                        while (li < longer.length) {
                            if (longer[li] === shorter[si]) { si++; li++; }
                            else { diff++; li++; }
                            if (diff > 1) return false;
                        }
                        return true;
                    });
                    if (byEdit.length === 1) {
                        fixed.push(byEdit[0]);
                        changes.push(`${word}→${byEdit[0]}`);
                    } else {
                        fixed.push(word); // لا يمكن التصحيح
                    }
                }
            }
        }
        return { corrected: fixed.join(' '), changes };
    }

    const wallets = [];

    for (let m = 0; m < mnemonics.length; m++) {
        let mn = mnemonics[m];
        // تصحيح العبارة إن احتاجت
        if (!validateMnemonic(mn, wordlist)) {
            const { corrected, changes } = correctMnemonic(mn);
            if (changes.length > 0 && validateMnemonic(corrected, wordlist)) {
                console.log(`  🔧 تصحيح تلقائي: ${changes.join(', ')}`);
                mn = corrected;
            }
        }
        try {
            const entries = deriveAddresses(mn);
            wallets.push({ mnemonic: mn, entries });
        } catch (e) {
            const preview = mn.split(' ').slice(0, 3).join(' ');
            console.log(`  ⚠️  فشل الاشتقاق: ${preview}... (${e.message})`);
        }
    }

    const totalAddr = wallets.reduce((s, w) => s + w.entries.length, 0);

    // ══════════════════════════════════════════
    //  المرحلة 2: فحص الأرصدة عنواناً تلو الآخر
    // ══════════════════════════════════════════
    // ── جلب قائمة الشبكات من OKX ──
    process.stdout.write('🌐 جلب الشبكات من OKX API... ');
    const nonEvmSolIds = await fetchNonEvmSolChains();
    const chainsStr    = nonEvmSolIds.join(',');
    console.log(`${nonEvmSolIds.length} شبكة`);
    console.log(`   (${nonEvmSolIds.slice(0, 8).join(' · ')} · ...)\n`);

    process.stdout.write('💱 جلب الأسعار الحالية... ');
    const prices = await fetchUTXOPrices();
    console.log(`BTC $${prices.BTC.toFixed(0)} · LTC $${prices.LTC.toFixed(2)} · DOGE $${prices.DOGE.toFixed(4)} · DASH $${prices.DASH.toFixed(2)} · BCH $${prices.BCH.toFixed(2)}`);
    console.log('\n💰 المرحلة 2: فحص الأرصدة...\n');

    // ── فحص كل عناوين عبارة واحدة بشكل متوازٍ حسب نوع الـ API ──
    async function checkWallet(entries) {
        const btc  = entries.filter(e => e.type === 'BTC' || e.type === 'BTC-TAP');
        const trx  = entries.filter(e => e.type === 'TRX');
        const ltc  = entries.filter(e => e.type === 'LTC');
        const doge = entries.filter(e => e.type === 'DOGE');
        const dash = entries.filter(e => e.type === 'DASH');
        const bch  = entries.filter(e => e.type === 'BCH');
        const sui  = entries.filter(e => e.type === 'SUI');

        // BTC: Blockstream + OKX معاً بالتوازي
        const btcPromises = btc.map(e => checkEntry(e, chainsStr, prices));

        // OKX TRX: كل شبكات OKX غير EVM/SOL — انتظار 600ms بين الطلبات
        const trxPromise = (async () => {
            const res = [];
            for (const e of trx) {
                if (res.length) await sleep(600);
                res.push(await checkEntry(e, chainsStr, prices));
            }
            return res;
        })();

        // LTC/DOGE/DASH/BCH: BlockCypher + OKX معاً بتأخيرات لحماية BlockCypher
        const ltcPromises  = Promise.all(ltc.map(e => checkEntry(e, chainsStr, prices)));
        const dogePromises = sleep(400).then(() => Promise.all(doge.map(e => checkEntry(e, chainsStr, prices))));
        const dashPromises = sleep(800).then(() => Promise.all(dash.map(e => checkEntry(e, chainsStr, prices))));
        const bchPromises  = sleep(1200).then(() => Promise.all(bch.map(e => checkEntry(e, chainsStr, prices))));

        // SUI: OKX فقط بالتوازي
        const suiPromises = Promise.all(sui.map(e => checkEntry(e, chainsStr, prices)));

        // تشغيل كل المجموعات بالتوازي
        const [btcRes, trxRes, ltcRes, dogeRes, dashRes, bchRes, suiRes] = await Promise.all([
            Promise.all(btcPromises),
            trxPromise,
            ltcPromises,
            dogePromises,
            dashPromises,
            bchPromises,
            suiPromises,
        ]);

        // إعادة الترتيب الأصلي
        const map = new Map();
        btc.forEach((e, i)  => map.set(e, btcRes[i]));
        trx.forEach((e, i)  => map.set(e, trxRes[i]));
        ltc.forEach((e, i)  => map.set(e, ltcRes[i]));
        doge.forEach((e, i) => map.set(e, dogeRes[i]));
        dash.forEach((e, i) => map.set(e, dashRes[i]));
        bch.forEach((e, i)  => map.set(e, bchRes[i]));
        sui.forEach((e, i)  => map.set(e, suiRes[i]));
        return entries.map(e => ({ entry: e, result: map.get(e) }));
    }

    const foundWallets = [];

    for (let mi = 0; mi < wallets.length; mi++) {
        const { mnemonic, entries } = wallets[mi];
        console.log(`\n🔍 [${mi + 1}/${wallets.length}] جارٍ الفحص...`);
        const t0 = Date.now();

        const results = await checkWallet(entries);
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

        const walletHits    = [];
        const activityHits  = [];
        for (const { entry, result } of results) {
            const { tokens, hasActivity } = result || { tokens: [], hasActivity: false };
            const total = tokens.reduce(
                (s, t) => s + parseFloat(t.balance || 0) * parseFloat(t.tokenPrice || 0), 0
            );
            const icon = tokens.length > 0
                ? `✅  $${total.toFixed(2)}`
                : hasActivity ? `✴️ ` : `❌`;
            console.log(`   [${entry.type}/${entry.index}] ${entry.addr.slice(0, 26)}…  ${icon}`);
            if (tokens.length > 0) walletHits.push({ ...entry, tokens, total });
            else if (hasActivity) activityHits.push(entry);
        }
        console.log(`   ⏱  ${elapsed}s`);

        if (walletHits.length > 0 || activityHits.length > 0) {
            const grand = walletHits.reduce((s, e) => s + e.total, 0);
            foundWallets.push({ mnemonic, hits: walletHits, activityHits, grand });
        }

        // نقل العبارة إلى End.txt فور انتهاء فحصها
        moveToEnd(mnemonic);

        // تأخير بسيط بين العبارات لحماية الـ APIs
        if (mi < wallets.length - 1) await sleep(700);
    }

    // ══════════════════════════════════════════
    //  كتابة النتائج
    // ══════════════════════════════════════════
    console.log('\n' + '═'.repeat(60));

    const withBalance  = foundWallets.filter(w => w.hits.length > 0);
    const withActivity = foundWallets.filter(w => w.activityHits.length > 0);

    if (foundWallets.length === 0) {
        out('❌ لا توجد أرصدة أو نشاط في أي عبارة');
    } else {
        // ── قسم 1: محافظ بها رصيد ──
        if (withBalance.length > 0) {
            withBalance.sort((a, b) => b.grand - a.grand);
            out('💰 محافظ بها رصيد:');
            for (const { mnemonic, hits, grand } of withBalance) {
                out('═'.repeat(60));
                out(`🔑 العبارة: ${mnemonic}`);
                out(`   💰 الإجمالي الكلي: $${grand.toFixed(2)}`);
                hits.sort((a, b) => b.total - a.total);
                for (const hit of hits) {
                    out(`\n   [${hit.label}/${hit.index}] ${hit.addr}`);
                    out(`   الإجمالي: $${hit.total.toFixed(2)}`);
                    const byChain = {};
                    for (const t of hit.tokens) {
                        const cn = OKX_CHAIN_NAMES[t.chainIndex] || `Chain ${t.chainIndex}`;
                        if (!byChain[cn]) byChain[cn] = [];
                        byChain[cn].push(t);
                    }
                    const sortedChains = Object.entries(byChain)
                        .map(([cn, ts]) => ({
                            cn, ts,
                            chainTotal: ts.reduce(
                                (s, t) => s + parseFloat(t.balance || 0) * parseFloat(t.tokenPrice || 0), 0
                            )
                        }))
                        .sort((a, b) => b.chainTotal - a.chainTotal);
                    for (const { cn, ts, chainTotal } of sortedChains) {
                        out(`      🔗 ${cn}  ($${chainTotal.toFixed(2)})`);
                        ts.sort((a, b) =>
                            parseFloat(b.balance || 0) * parseFloat(b.tokenPrice || 0) -
                            parseFloat(a.balance || 0) * parseFloat(a.tokenPrice || 0)
                        );
                        for (const t of ts) {
                            const bal      = parseFloat(t.balance || 0);
                            const price    = parseFloat(t.tokenPrice || 0);
                            const usd      = bal * price;
                            const priceStr = price < 1 ? price.toFixed(8) : price.toFixed(2);
                            let line = `         • ${t.symbol.padEnd(10)} ${fmt(bal).padStart(18)}  @$${priceStr.padStart(12)}  ≈ $${usd.toFixed(2)}`;
                            if (t.tokenAddress) line += `\n           عقد: ${t.tokenAddress}`;
                            out(line);
                        }
                    }
                }
                out('');
            }
        }

        // ── قسم 2: عناوين نشطة بلا رصيد ✴️ ──
        if (withActivity.length > 0) {
            out('');
            out('✴️  عناوين نشطة (استُخدمت — رصيد صفري حالياً):');
            for (const { mnemonic, activityHits } of withActivity) {
                if (!activityHits.length) continue;
                out('─'.repeat(60));
                out(`🔑 العبارة: ${mnemonic}`);
                for (const h of activityHits) {
                    out(`   ✴️  [${h.type}/${h.index}] ${h.addr}`);
                }
                out('');
            }
        }
    }

    const balCount = withBalance.length;
    const actCount = withActivity.filter(w => !withBalance.includes(w)).length + withBalance.filter(w => w.activityHits.length > 0).length;
    out('═'.repeat(60));
    out(`📊 عبارات بها رصيد: ${balCount}/${wallets.length} | عناوين ✴️: ${foundWallets.reduce((s,w)=>s+w.activityHits.length,0)}`);
    console.log(`\n✅ انتهى | رصيد: ${balCount} | ✴️ نشطة: ${foundWallets.reduce((s,w)=>s+w.activityHits.length,0)}`);
    console.log(`📄 النتائج: ${OUTPUT_FILE}`);
}

// ─────────────────────────────────────────────
//  COMMANDS 8 & 9 — OKX DeFi Positions
// ─────────────────────────────────────────────

// POST /api/v5/defi/user/asset/platform/list
// Body: { walletAddressList: [{ walletAddress, chainIndex }] }
// ─── دالة OKX DeFi المساعدة (عنوان واحد) ───────────────────────────────────
async function fetchOKXDefiPlatforms(walletAddress, chainIndices) {
    const walletAddressList = chainIndices.map(ci => ({ walletAddress, chainIndex: String(ci) }));
    const body    = { walletAddressList };
    const bodyStr = JSON.stringify(body);
    const apiPath = '/api/v5/defi/user/asset/platform/list';
    const delays  = [0, 1000, 2500];
    for (let attempt = 0; attempt < 3; attempt++) {
        if (delays[attempt] > 0) await sleep(delays[attempt]);
        const ts  = new Date().toISOString();
        const sig = signOKX(ts, 'POST', apiPath, bodyStr);
        try {
            const r = await axios.post('https://www.okx.com' + apiPath, body, {
                headers: {
                    'OK-ACCESS-KEY':        OKX_API_KEY,
                    'OK-ACCESS-SIGN':       sig,
                    'OK-ACCESS-TIMESTAMP':  ts,
                    'OK-ACCESS-PASSPHRASE': OKX_PASSPHRASE,
                    'Content-Type':         'application/json',
                },
                timeout: 15000,
            });
            if (r.data.code === '0' || r.data.code === 0) {
                const list = r.data.data?.walletIdPlatformList || [];
                const platforms = [];
                for (const item of list) platforms.push(...(item.platformList || []));
                const map = new Map();
                for (const p of platforms) {
                    const key = String(p.analysisPlatformId || p.platformName);
                    if (map.has(key)) {
                        const ex = map.get(key);
                        ex.currencyAmount = String(
                            parseFloat(ex.currencyAmount || 0) + parseFloat(p.currencyAmount || 0)
                        );
                    } else {
                        map.set(key, { ...p });
                    }
                }
                return { ok: true, platforms: [...map.values()] };
            }
            return { ok: false, error: `OKX API code=${r.data.code} msg=${r.data.msg || ''}` };
        } catch (e) {
            const is429 = e.response?.status === 429;
            const errMsg = e.response
                ? `HTTP ${e.response.status}: ${JSON.stringify(e.response.data).slice(0, 120)}`
                : e.message;
            if (attempt === 2 || (!is429 && attempt === 1)) return { ok: false, error: errMsg };
        }
    }
    return { ok: false, error: 'فشل الاتصال بعد 3 محاولات' };
}

// ─── فحص دفعة من العناوين في طلب واحد ──────────────────────────────────────
// الـ API يُرجع فقط العناوين التي لديها مراكز (بدون تحديد walletAddress).
// نستغل هذا: إذا الرد فارغ → لا مراكز لأي عنوان في الدفعة (نتخطاها بطلب واحد).
// إذا الرد فيه بيانات → نعيد الفحص الفردي لتحديد مَن لديه المراكز.
async function batchHasDefiPositions(addresses, chainIndex) {
    const walletAddressList = addresses.map(a => ({ walletAddress: a, chainIndex: String(chainIndex) }));
    const body    = { walletAddressList };
    const bodyStr = JSON.stringify(body);
    const apiPath = '/api/v5/defi/user/asset/platform/list';
    const delays  = [0, 1000, 2500];
    for (let attempt = 0; attempt < 3; attempt++) {
        if (delays[attempt] > 0) await sleep(delays[attempt]);
        const ts  = new Date().toISOString();
        const sig = signOKX(ts, 'POST', apiPath, bodyStr);
        try {
            const r = await axios.post('https://www.okx.com' + apiPath, body, {
                headers: {
                    'OK-ACCESS-KEY':        OKX_API_KEY,
                    'OK-ACCESS-SIGN':       sig,
                    'OK-ACCESS-TIMESTAMP':  ts,
                    'OK-ACCESS-PASSPHRASE': OKX_PASSPHRASE,
                    'Content-Type':         'application/json',
                },
                timeout: 15000,
            });
            if (r.data.code === '0' || r.data.code === 0) {
                const list = r.data.data?.walletIdPlatformList || [];
                const hasPositions = list.some(item =>
                    (item.platformList || []).some(p => parseFloat(p.currencyAmount || 0) > 0.01)
                );
                return { ok: true, hasPositions };
            }
            return { ok: false, error: `OKX code=${r.data.code} msg=${r.data.msg || ''}` };
        } catch (e) {
            const is429 = e.response?.status === 429;
            const errMsg = e.response
                ? `HTTP ${e.response.status}: ${JSON.stringify(e.response.data).slice(0, 120)}`
                : e.message;
            if (attempt === 2 || (!is429 && attempt === 1)) return { ok: false, error: errMsg };
        }
    }
    return { ok: false, error: 'فشل الاتصال بعد 3 محاولات' };
}

// سطر تنسيق منصة DeFi
function formatDefiPlatform(p, i) {
    const name  = p.platformName || 'بروتوكول';
    const usd   = parseFloat(p.currencyAmount || 0);
    const nets  = (p.networkBalanceVoList || []).map(n => n.network).join(', ') || '—';
    const count = p.investmentCount || 0;
    return `      ${i + 1}. ${name.padEnd(30)} $${usd.toFixed(2).padStart(14)}   [${nets}]  (${count} مركز)`;
}

// ── أمر 8: مراكز EVM DeFi ──
async function runOKXEvmDefi() {
    const OUTPUT_FILE = require('path').join(__dirname, 'results_evm_defi.txt');
    const out = (l) => { console.log(l); fs.appendFileSync(OUTPUT_FILE, l + '\n', 'utf-8'); };

    fs.writeFileSync(OUTPUT_FILE, `=== مراكز EVM DeFi — ${new Date().toLocaleString()} ===\n\n`, 'utf-8');
    console.log('\n📋 أمر 8 — OKX DeFi: مراكز EVM المفتوحة');
    console.log(`   الشبكات: ${OKX_ALL_EVM_CHAINS.length} شبكة (${OKX_ALL_EVM_CHAINS.map(id => OKX_CHAIN_NAMES[id]).join(' · ')})\n`);

    const all  = readAddresses();
    const evms = all.filter(a => /^0x[0-9a-fA-F]{40}$/.test(a));
    if (!evms.length) { console.log('❌ لا توجد عناوين EVM (0x...) في الملف'); return; }
    console.log(`📂 عناوين EVM: ${evms.length}/${all.length}\n`);

    const EVM_CHAINS = OKX_ALL_EVM_CHAINS;

    let found = 0;
    for (let i = 0; i < evms.length; i++) {
        const addr = evms[i];
        process.stdout.write(`🔍 [${i + 1}/${evms.length}] ${addr.slice(0, 20)}… `);
        if (i > 0) await sleep(800);

        const res    = await fetchOKXDefiPlatforms(addr, EVM_CHAINS);
        if (!res.ok) { process.stdout.write(`⚠️  خطأ: ${res.error}\n`); continue; }
        const active = res.platforms.filter(p => parseFloat(p.currencyAmount || 0) > 0.01);
        active.sort((a, b) => parseFloat(b.currencyAmount) - parseFloat(a.currencyAmount));

        if (active.length === 0) { process.stdout.write('❌\n'); continue; }

        const total = active.reduce((s, p) => s + parseFloat(p.currencyAmount || 0), 0);
        process.stdout.write(`✅  $${total.toFixed(2)}  (${active.length} بروتوكول)\n`);
        found++;

        out('─'.repeat(60));
        out(`✅ ${addr}`);
        out(`   إجمالي المراكز: $${total.toFixed(2)}`);
        out(`   البروتوكولات (${active.length}):`);
        active.forEach((p, idx) => out(formatDefiPlatform(p, idx)));
        out('');
    }

    out('═'.repeat(60));
    out(`📊 ${found}/${evms.length} عنوان لديه مراكز DeFi مفتوحة`);
    console.log(`\n✅ انتهى | ${found}/${evms.length} لديهم مراكز`);
    console.log(`📄 النتائج: ${OUTPUT_FILE}`);
}

// ── أمر 9: مراكز Solana DeFi ──
// استراتيجية مرحلتين:
//   المرحلة 1 — إرسال 3 عناوين في طلب واحد → إذا الرد فارغ نتخطى الثلاثة بطلب واحد (أسرع 3x)
//   المرحلة 2 — عند وجود مراكز في الدفعة: إعادة الفحص الفردي لمعرفة مَن لديه المراكز بالضبط
async function runOKXSolanaDefi() {
    const OUTPUT_FILE = require('path').join(__dirname, 'results_sol_defi.txt');
    const out = (l) => { console.log(l); fs.appendFileSync(OUTPUT_FILE, l + '\n', 'utf-8'); };

    fs.writeFileSync(OUTPUT_FILE, `=== مراكز Solana DeFi — ${new Date().toLocaleString()} ===\n\n`, 'utf-8');
    console.log('\n📋 أمر 9 — OKX DeFi: مراكز Solana المفتوحة');
    console.log('   الاستراتيجية: فحص دفعي 3×1 → فردي عند الإيجابيات\n');

    const all      = readAddresses();
    const solAddrs = all.filter(a =>
        !a.startsWith('0x') &&
        /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)
    );
    if (!solAddrs.length) { console.log('❌ لا توجد عناوين Solana في الملف'); return; }

    const BATCH_SIZE = 3;
    const totalBatches = Math.ceil(solAddrs.length / BATCH_SIZE);
    console.log(`📂 عناوين Solana: ${solAddrs.length}/${all.length} | ${totalBatches} دفعة (${BATCH_SIZE} عناوين/طلب)\n`);

    let found    = 0;
    let errCount = 0;
    let reqCount = 0;
    const allResults = [];

    for (let i = 0; i < solAddrs.length; i += BATCH_SIZE) {
        const batch     = solAddrs.slice(i, i + BATCH_SIZE);
        const batchNum  = Math.floor(i / BATCH_SIZE) + 1;
        const rangeStr  = `${i + 1}–${Math.min(i + BATCH_SIZE, solAddrs.length)}`;

        process.stdout.write(`🔍 [دفعة ${batchNum}/${totalBatches}] عناوين ${rangeStr}/${solAddrs.length} … `);
        if (i > 0) await sleep(700);
        reqCount++;

        // ─ المرحلة 1: فحص الدفعة كاملة ─
        const check = await batchHasDefiPositions(batch, 501);
        if (!check.ok) {
            errCount++;
            process.stdout.write(`⚠️  خطأ: ${check.error}\n`);
            continue;
        }
        if (!check.hasPositions) {
            process.stdout.write('❌ لا مراكز\n');
            continue;
        }
        process.stdout.write(`🎯 يوجد مراكز! → فحص فردي\n`);

        // ─ المرحلة 2: فحص فردي لتحديد مَن لديه المراكز ─
        for (let j = 0; j < batch.length; j++) {
            const addr = batch[j];
            process.stdout.write(`   🔎 [${i + j + 1}/${solAddrs.length}] ${addr.slice(0, 24)}… `);
            if (j > 0) await sleep(700);
            reqCount++;

            const res = await fetchOKXDefiPlatforms(addr, ['501']);
            if (!res.ok) {
                errCount++;
                process.stdout.write(`⚠️  خطأ: ${res.error}\n`);
                fs.appendFileSync(OUTPUT_FILE, `⚠️  ${addr}\n   خطأ: ${res.error}\n\n`, 'utf-8');
                continue;
            }
            const active = res.platforms.filter(p => parseFloat(p.currencyAmount || 0) > 0.01);
            active.sort((a, b) => parseFloat(b.currencyAmount) - parseFloat(a.currencyAmount));
            if (active.length === 0) { process.stdout.write('❌\n'); continue; }
            const total = active.reduce((s, p) => s + parseFloat(p.currencyAmount || 0), 0);
            process.stdout.write(`✅  $${total.toFixed(2)}  (${active.length} بروتوكول)\n`);
            found++;
            allResults.push({ addr, total, active });
        }
    }

    // كتابة النتائج مرتبة تنازلياً
    allResults.sort((a, b) => b.total - a.total);
    for (const { addr, total, active } of allResults) {
        out('─'.repeat(60));
        out(`✅ ${addr}`);
        out(`   إجمالي المراكز: $${total.toFixed(2)}`);
        out(`   البروتوكولات (${active.length}):`);
        active.forEach((p, idx) => out(formatDefiPlatform(p, idx)));
        out('');
    }

    out('═'.repeat(60));
    out(`📊 ${found}/${solAddrs.length} عنوان لديه مراكز DeFi مفتوحة${errCount ? ` | ⚠️ أخطاء: ${errCount}` : ''}`);
    console.log(`\n✅ انتهى | ${found}/${solAddrs.length} لديهم مراكز | طلبات API: ${reqCount}${errCount ? ` | ⚠️ ${errCount} خطأ` : ''}`);
    console.log(`📄 النتائج: ${OUTPUT_FILE}`);
}

// ─────────────────────────────────────────────
//  COMMAND 10 — Moralis: فحص الموافقات (Approvals)
// ─────────────────────────────────────────────
const MORALIS_API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6IjU2OGYxNjczLWIwMDUtNDNmYi1hZTAyLTQ3MGU4MmYyNDg2MSIsIm9yZ0lkIjoiNDczOTQ4IiwidXNlcklkIjoiNDg3NTU1IiwidHlwZUlkIjoiNWRlZmI2YjUtYjZiZi00YzI1LTg3NmUtNDE2NDA3NTU0N2E5IiwidHlwZSI6IlBST0pFQ1QiLCJpYXQiOjE3NTk1MzY5MDUsImV4cCI6NDkxNTI5NjkwNX0.SNDEkDEeT0NS8Itv975RwcP_q_kcjN4FI9pj5pNsNsw';

// الشبكات المدعومة فعلياً في endpoint getNativeBalancesForAddresses
// (تم التحقق بالاختبار — الشبكات التي ترجع "chain must be a valid enum val" محذوفة)
const MORALIS_CHAINS = [
    { id: '0x1',    name: 'Ethereum'  },
    { id: '0xa',    name: 'Optimism'  },
    { id: '0x19',   name: 'Cronos'    },
    { id: '0x38',   name: 'BNB Chain' },
    { id: '0x64',   name: 'Gnosis'    },
    { id: '0x89',   name: 'Polygon'   },
    { id: '0x504',  name: 'Moonbeam'  },
    { id: '0x505',  name: 'Moonriver' },
    { id: '0x7e4',  name: 'Ronin'     },
    { id: '0x2105', name: 'Base'      },
    { id: '0xa4b1', name: 'Arbitrum'  },
    { id: '0xa86a', name: 'Avalanche' },
    { id: '0xe708', name: 'Linea'     },
];

async function fetchMoralisApprovals(address, chainId) {
    try {
        const r = await axios.get(
            `https://deep-index.moralis.io/api/v2.2/wallets/${address}/approvals`,
            {
                params: { chain: chainId },
                headers: { 'X-API-Key': MORALIS_API_KEY },
                timeout: 15000,
            }
        );
        return r.data?.result || [];
    } catch (_) {
        return null;
    }
}

async function runMoralisApprovals() {
    const OUTPUT_FILE = require('path').join(__dirname, 'results_approvals.txt');
    const out = (l) => { console.log(l); fs.appendFileSync(OUTPUT_FILE, l + '\n', 'utf-8'); };

    fs.writeFileSync(OUTPUT_FILE, `=== موافقات DeFi (Moralis) — ${new Date().toLocaleString()} ===\n\n`, 'utf-8');
    console.log('\n📋 أمر 10 — Moralis: فحص موافقات DeFi (ERC-20 Approvals)');
    console.log(`   الشبكات: ${MORALIS_CHAINS.map(c => c.name).join(' · ')}\n`);

    const addresses = readAddresses().filter(a => /^0x[0-9a-fA-F]{40}$/.test(a));
    if (!addresses.length) { console.log('❌ لا توجد عناوين EVM (0x...) في الملف'); return; }
    console.log(`📂 عناوين EVM: ${addresses.length}\n`);

    let totalFound = 0;

    for (let i = 0; i < addresses.length; i++) {
        const addr = addresses[i];
        process.stdout.write(`🔍 [${i + 1}/${addresses.length}] ${addr.slice(0, 20)}… `);
        if (i > 0) await sleep(300);

        // فحص كل الشبكات بالتوازي
        const chainResults = await Promise.all(
            MORALIS_CHAINS.map(async chain => {
                const approvals = await fetchMoralisApprovals(addr, chain.id);
                return { chain, approvals };
            })
        );

        const allApprovals = [];
        for (const { chain, approvals } of chainResults) {
            if (!approvals) continue;
            for (const ap of approvals) {
                const usdRisk = parseFloat(ap.usd_at_risk || 0);
                if (usdRisk < 0.01) continue;
                allApprovals.push({ chain, ap, usdRisk });
            }
        }

        // ترتيب حسب قيمة الخطر تنازلياً
        allApprovals.sort((a, b) => b.usdRisk - a.usdRisk);

        if (allApprovals.length === 0) {
            process.stdout.write('✅ لا موافقات نشطة\n');
            continue;
        }

        const totalRisk = allApprovals.reduce((s, x) => s + x.usdRisk, 0);
        process.stdout.write(`⚠️  ${allApprovals.length} موافقة | خطر: $${totalRisk.toFixed(2)}\n`);
        totalFound++;

        out('─'.repeat(68));
        out(`⚠️  ${addr}`);
        out(`   إجمالي الرصيد في خطر: $${totalRisk.toFixed(2)} | ${allApprovals.length} موافقة`);
        out('');

        for (const { chain, ap, usdRisk } of allApprovals) {
            const tokenName    = ap.token?.name    || ap.token?.symbol || 'توكن مجهول';
            const tokenSym     = ap.token?.symbol  || '?';
            const tokenAddr    = ap.token?.address || '?';
            const spenderAddr  = ap.spender?.address || '?';
            const spenderLabel = ap.spender?.address_label || ap.spender?.entity || '';
            const isUnlimited  = ap.value === '115792089237316195423570985008687907853269984665640564039457584007913129639935'
                              || ap.approved_amount === 'Unlimited';
            const amountStr    = isUnlimited ? '♾️  غير محدود' : `${ap.value_formatted || ap.approved_amount || '?'}`;

            out(`   [${chain.name}] ${tokenSym} (${tokenName})`);
            out(`     التوكن  : ${tokenAddr}`);
            out(`     المُنفِق : ${spenderAddr}${spenderLabel ? ' — ' + spenderLabel : ''}`);
            out(`     المبلغ  : ${amountStr}`);
            out(`     الخطر   : $${usdRisk.toFixed(2)}`);
            out('');
        }
    }

    out('═'.repeat(68));
    out(`📊 عناوين بموافقات نشطة: ${totalFound}/${addresses.length}`);
    console.log(`\n✅ انتهى | ${totalFound}/${addresses.length} لديهم موافقات نشطة`);
    console.log(`📄 النتائج: ${OUTPUT_FILE}`);
}

// ─────────────────────────────────────────────
//  COMMAND 16 — Moralis: الرصيد الأصلي (35 عنوان/طلب)
// ─────────────────────────────────────────────
async function runMoralisNativeBalances() {
    const OUTPUT_FILE = path.join(__dirname, 'results_moralis_native.txt');
    const out = (l) => { console.log(l); fs.appendFileSync(OUTPUT_FILE, l + '\n', 'utf-8'); };

    fs.writeFileSync(OUTPUT_FILE, `=== Moralis — الرصيد الأصلي — ${new Date().toLocaleString()} ===\n\n`, 'utf-8');
    console.log(`\n📋 أمر 16 — Moralis: الرصيد الأصلي (25 عنوان/طلب · ${MORALIS_CHAINS.length} شبكة متوازية)`);
    console.log(`   الشبكات: ${MORALIS_CHAINS.map(c => c.name).join(' · ')}\n`);

    const addresses = readAddresses().filter(a => /^0x[0-9a-fA-F]{40}$/.test(a));
    if (!addresses.length) { console.log('❌ لا توجد عناوين EVM (0x...) في الملف'); return; }
    console.log(`📂 عناوين EVM: ${addresses.length}\n`);

    const BATCH_SIZE  = 25;  // الحد الفعلي الذي تطبّقه Moralis API
    const totalBatches = Math.ceil(addresses.length / BATCH_SIZE);

    // تجميع النتائج: { address_lower -> { chainName -> balance_formatted } }
    const resultMap = {};
    for (const addr of addresses) resultMap[addr.toLowerCase()] = {};

    const errors = [];   // { batchNum, chainName, status, msg }

    // دالة مساعدة: تجلب الرصيد لـ batch واحد على شبكة واحدة
    async function fetchBatch(batch, chain, batchNum) {
        const qs = new URLSearchParams();
        qs.append('chain', chain.id);
        for (const addr of batch) qs.append('wallet_addresses[]', addr);

        try {
            const r = await axios.get(
                `https://deep-index.moralis.io/api/v2.2/wallets/balances?${qs.toString()}`,
                { headers: { 'X-API-Key': MORALIS_API_KEY }, timeout: 20000 }
            );
            for (const wb of (r.data?.wallet_balances || [])) {
                const key = wb.address?.toLowerCase();
                if (!key || resultMap[key] === undefined) continue;
                const bal = wb.balance_formatted ?? (Number(wb.balance || 0) / 1e18).toFixed(10);
                if (Number(bal) > 0) resultMap[key][chain.name] = bal;
            }
            return true;
        } catch (e) {
            const status = e.response?.status ?? 'timeout';
            const msg    = (e.response?.data?.message ?? e.message ?? '?').slice(0, 80);
            errors.push({ batchNum, chainName: chain.name, status, msg });
            return false;
        }
    }

    // لكل دفعة من 35 عنواناً: فحص جميع الشبكات بالتوازي
    for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
        const batch    = addresses.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;

        process.stdout.write(`🔍 دفعة ${batchNum}/${totalBatches} (${batch.length} عنوان · ${MORALIS_CHAINS.length} شبكة)...`);

        const results = await Promise.all(
            MORALIS_CHAINS.map(chain => fetchBatch(batch, chain, batchNum))
        );

        const ok  = results.filter(Boolean).length;
        const err = results.length - ok;
        process.stdout.write(` ✓${ok} شبكة${err > 0 ? ` ❌${err} خطأ` : ''}\n`);

        // تأخير بين الدفعات لتجنب rate-limit (429)
        if (i + BATCH_SIZE < addresses.length) await sleep(500);
    }

    // عرض أخطاء الاتصال إن وُجدت
    if (errors.length > 0) {
        console.log(`\n⚠️  أخطاء الاتصال (${errors.length}):`);
        for (const e of errors) {
            const line = `   ❌ [دفعة ${e.batchNum}] ${e.chainName.padEnd(14)}: HTTP ${e.status} — ${e.msg}`;
            console.log(line);
            fs.appendFileSync(OUTPUT_FILE, line + '\n', 'utf-8');
        }
        fs.appendFileSync(OUTPUT_FILE, '\n', 'utf-8');
    }

    console.log('');

    // عرض النتائج — العناوين ذات الرصيد فقط في الملف، الفارغة في الكونسول فقط
    let activeCount = 0;
    for (const addr of addresses) {
        const chainBalances = resultMap[addr.toLowerCase()];
        const active        = Object.entries(chainBalances);

        if (active.length > 0) {
            activeCount++;
            const line = ['─'.repeat(60), `✅ ${addr}  ← نشطة`,
                ...active.map(([n, b]) => `   ${n.padEnd(14)}: ${b}`), ''].join('\n');
            process.stdout.write(line + '\n');
            fs.appendFileSync(OUTPUT_FILE, line + '\n', 'utf-8');
        } else {
            console.log(`⬜ ${addr}  — لا رصيد`);
        }
    }

    const summary = `\n${'═'.repeat(60)}\n📊 الملخص: ${activeCount} محفظة نشطة من أصل ${addresses.length} | أخطاء: ${errors.length}`;
    console.log(summary);
    fs.appendFileSync(OUTPUT_FILE, summary + '\n', 'utf-8');

    console.log(`\n✅ انتهى | ${activeCount}/${addresses.length} محافظ نشطة`);
    console.log(`📄 النتائج: ${OUTPUT_FILE}`);
}

// ─────────────────────────────────────────────
//  COMMAND 11 — RPC-based Seed Scan (بدون OKX)
// ─────────────────────────────────────────────

// ── Base32 بلا padding (مشترك لـ XLM و ALGO) ──
function base32NoPad(buf) {
    const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0, val = 0, out = '';
    for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out += ALPHA[(val >>> bits) & 0x1F]; } }
    if (bits > 0) out += ALPHA[(val << (5 - bits)) & 0x1F];
    return out;
}

// ── CRC16-XModem (لـ Stellar XLM) ──
function crc16xmodem(buf) {
    let crc = 0x0000;
    for (const b of buf) { crc ^= b << 8; for (let j = 0; j < 8; j++) { if (crc & 0x8000) crc = (crc << 1) ^ 0x1021; else crc <<= 1; crc &= 0xFFFF; } }
    return crc;
}

// ── ترميز عنوان Stellar (StrKey G...) ──
function encodeXLMAddress(pub32) {
    const payload = Buffer.concat([Buffer.from([0x30]), Buffer.from(pub32)]);
    const c = crc16xmodem(payload);
    const chk = Buffer.alloc(2); chk.writeUInt16LE(c, 0);
    return base32NoPad(Buffer.concat([payload, chk]));
}

// ── ترميز عنوان Algorand (Base32 + sha512/256 checksum) ──
function encodeALGOAddress(pub32) {
    let chk;
    try { chk = crypto.createHash('sha512-256').update(pub32).digest().slice(-4); }
    catch (_) { chk = crypto.createHash('sha256').update(pub32).digest().slice(-4); }
    return base32NoPad(Buffer.concat([Buffer.from(pub32), chk]));
}

// ── تشفير Ripple Base58Check (حرف أبجدي خاص بـ XRP) ──
// ── SS58 (Polkadot/Kusama) ──
function encodeSubstrateAddress(pub32, networkPrefix) {
    const { blake2b } = require('@noble/hashes/blake2');
    const { base58 }  = require('@scure/base');
    const SS58PRE     = Buffer.from('SS58PRE');
    const prefix      = Buffer.from([networkPrefix]);           // prefix < 64
    const payload     = Buffer.concat([prefix, Buffer.from(pub32)]);
    const hash        = blake2b(Buffer.concat([SS58PRE, payload]), { dkLen: 64 });
    const full        = Buffer.concat([payload, Buffer.from(hash.slice(0, 2))]);
    return base58.encode(full);
}

function encodeRippleBase58Check(payload) {
    const RIPPLE_ALPHA = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
    const sha256d = (buf) => {
        const h1 = crypto.createHash('sha256').update(buf).digest();
        return crypto.createHash('sha256').update(h1).digest();
    };
    const checksum = sha256d(payload).slice(0, 4);
    const full = Buffer.concat([Buffer.from(payload), checksum]);
    let num = BigInt('0x' + full.toString('hex'));
    let result = '';
    const base = 58n;
    while (num > 0n) {
        const rem = num % base;
        result = RIPPLE_ALPHA[Number(rem)] + result;
        num = num / base;
    }
    for (let i = 0; i < full.length && full[i] === 0; i++) result = RIPPLE_ALPHA[0] + result;
    return result;
}

// ── c32check encoding لـ Stacks/STX (BigInt، مُتحقَّق بمكتبة c32check الرسمية) ──
function encodeC32Check(version, hashBytes) {
    const { sha256 } = require('@noble/hashes/sha2');
    const C32     = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const ver     = Buffer.from([version]);
    const chk     = Buffer.from(sha256(sha256(Buffer.concat([ver, Buffer.from(hashBytes)])))).slice(0, 4);
    const payload = Buffer.concat([Buffer.from(hashBytes), chk]);
    let n = BigInt('0x' + payload.toString('hex'));
    let result = '';
    while (n > 0n) { result = C32[Number(n % 32n)] + result; n /= 32n; }
    let nz = 0;
    for (const b of payload) { if (b === 0) nz++; else break; }
    return 'S' + C32[version] + C32[0].repeat(nz) + result;
}

// ── تشفير عنوان TON WalletV4R2 من مفتاح Ed25519 ──
function encodeTONv4(pubkey) {
    const { sha256 } = require('@noble/hashes/sha2');
    const CODE_HASH = Buffer.from('84DAFA449F98A6987789BA232C4F6D5F17E23C13B8EA29CA88D0B1EB3DEAA4B9', 'hex');
    // خلية البيانات: walletId(32)+seqno=0(32)+pubkey(256)+empty_dict(1) = 321 بت → d2=0x51
    const data = Buffer.alloc(41);
    data.writeUInt32BE(698983191, 0);
    Buffer.from(pubkey).copy(data, 8);
    data[40] = 0x40; // بت قاموس فارغ + بت علامة التوقف
    const dataHash  = sha256(Buffer.concat([Buffer.from([0x00, 0x51]), data]));
    // StateInit: 5 بتات (00110) + مرجعان → d1=0x02, d2=0x01, data_byte=0x34
    const stateHash = sha256(Buffer.concat([Buffer.from([0x02, 0x01, 0x34]), CODE_HASH, Buffer.from(dataHash)]));
    // عنوان ودي غير قابل للإرجاع (UQ...)
    const raw = Buffer.alloc(36);
    raw[0] = 0x51; raw[1] = 0x00;
    Buffer.from(stateHash).copy(raw, 2);
    const crcVal = crc16xmodem(raw);
    const crcBuf = Buffer.alloc(2); crcBuf.writeUInt16BE(crcVal, 0);
    return Buffer.concat([raw, crcBuf]).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

// ── ترميز عنوان Nano (XNO) ──
function encodeNanoAddress(pubkey, checksumRev) {
    const NANO_ALPHA = '13456789abcdefghijkmnopqrstuwxyz';
    let n = 0n; for (const b of pubkey) n = (n << 8n) | BigInt(b);
    let ps = ''; for (let j = 0; j < 52; j++) { ps = NANO_ALPHA[Number(n & 0x1fn)] + ps; n >>= 5n; }
    let c = 0n; for (const b of checksumRev) c = (c << 8n) | BigInt(b);
    let cs = ''; for (let j = 0; j < 8; j++) { cs = NANO_ALPHA[Number(c & 0x1fn)] + cs; c >>= 5n; }
    return 'nano_' + ps + cs;
}

// ── ترميز عنوان Bitcoin Cash بصيغة CashAddr (P2PKH) ──
function encodeCashAddr(prefix, hash160) {
    const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    const payload = new Uint8Array([0x00, ...hash160]); // version 0x00 = P2PKH-20
    const data5 = [];
    let acc = 0, bits = 0;
    for (const b of payload) {
        acc = (acc << 8) | b; bits += 8;
        while (bits >= 5) { bits -= 5; data5.push((acc >> bits) & 0x1f); }
    }
    if (bits > 0) data5.push((acc << (5 - bits)) & 0x1f);
    function polymod(v) {
        let c = 1n;
        for (const d of v) {
            const c0 = c >> 35n; c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
            if (c0 & 1n) c ^= 0x98f2bc8e61n; if (c0 & 2n) c ^= 0x79b76d99e2n;
            if (c0 & 4n) c ^= 0xf33e5fb3c4n; if (c0 & 8n) c ^= 0xae2eabe2a8n;
            if (c0 & 16n) c ^= 0x1e4f43e470n;
        }
        return c ^ 1n;
    }
    const pfxData = [...[...prefix].map(ch => ch.charCodeAt(0) & 0x1f), 0];
    const chk = polymod([...pfxData, ...data5, 0, 0, 0, 0, 0, 0, 0, 0]);
    const chkW = Array.from({ length: 8 }, (_, j) => Number((chk >> BigInt((7 - j) * 5)) & 0x1fn));
    return prefix + ':' + [...data5, ...chkW].map(w => CHARSET[w]).join('');
}


// ── اشتقاق العناوين الموسّع — شبكات موسّعة ──
function deriveAddressesExtended(mnemonic) {
    const { sha256 }               = require('@noble/hashes/sha2');
    const { keccak_256, sha3_256 } = require('@noble/hashes/sha3');
    const { ripemd160 }          = require('@noble/hashes/legacy');
    const { secp256k1 }          = require('@noble/curves/secp256k1');
    const { ed25519 }            = require('@noble/curves/ed25519');
    const { blake2b }            = require('@noble/hashes/blake2');
    const { HDKey }              = require('@scure/bip32');
    const { mnemonicToSeedSync } = require('@scure/bip39');
    const { bech32, bech32m, base58 } = require('@scure/base');
    const bs58checkRaw           = require('bs58check');
    const bs58check              = bs58checkRaw.default || bs58checkRaw;

    const seed = Buffer.from(mnemonicToSeedSync(mnemonic));
    const root = HDKey.fromMasterSeed(seed);
    const entries = [];

    // مساعدة: Cosmos m/44'/118' — محمّلة من chains.json
    const cosmosPrefixes = CHAINS.cosmos.prefixes;

    for (const i of [0]) {
        // ── Bitcoin Native SegWit (bc1q) ──
        const bk   = root.derive(`m/84'/0'/0'/0/${i}`);
        const bh16 = ripemd160(sha256(bk.publicKey));
        const btc  = bech32.encode('bc', [0, ...bech32.toWords(Buffer.from(bh16))]);
        entries.push({ type: 'BTC', label: 'Bitcoin', index: i, addr: btc });

        // ── Bitcoin Taproot (bc1p) ──
        const tk2   = root.derive(`m/86'/0'/0'/0/${i}`);
        const xonly = tk2.publicKey.slice(1);
        const tap   = bech32m.encode('bc', [1, ...bech32m.toWords(xonly)]);
        entries.push({ type: 'BTC-TAP', label: 'Bitcoin-Taproot', index: i, addr: tap });

        // ── TRON ──
        const trxk  = root.derive(`m/44'/195'/0'/0/${i}`);
        const trxu  = secp256k1.getPublicKey(trxk.privateKey, false).slice(1);
        const trxh  = keccak_256(trxu);
        const trxb  = new Uint8Array(21); trxb[0] = 0x41; trxb.set(trxh.slice(-20), 1);
        entries.push({ type: 'TRX', label: 'TRON', index: i, addr: bs58check.encode(trxb) });

        // ── Litecoin ──
        const lk  = root.derive(`m/44'/2'/0'/0/${i}`);
        const lh  = ripemd160(sha256(lk.publicKey));
        const lb  = new Uint8Array(21); lb[0] = 0x30; lb.set(lh, 1);
        entries.push({ type: 'LTC', label: 'Litecoin', index: i, addr: bs58check.encode(lb) });

        // ── Dogecoin ──
        const dk  = root.derive(`m/44'/3'/0'/0/${i}`);
        const dh  = ripemd160(sha256(dk.publicKey));
        const db  = new Uint8Array(21); db[0] = 0x1e; db.set(dh, 1);
        entries.push({ type: 'DOGE', label: 'Dogecoin', index: i, addr: bs58check.encode(db) });

        // ── Dash ──
        const dashk = root.derive(`m/44'/5'/0'/0/${i}`);
        const dashh = ripemd160(sha256(dashk.publicKey));
        const dashb = new Uint8Array(21); dashb[0] = 0x4C; dashb.set(dashh, 1);
        entries.push({ type: 'DASH', label: 'Dash', index: i, addr: bs58check.encode(dashb) });

        // ── Bitcoin Cash (BCH) — CashAddr (P2PKH) ──
        const bchk = root.derive(`m/44'/145'/0'/0/${i}`);
        const bchh = ripemd160(sha256(bchk.publicKey));
        entries.push({ type: 'BCH', label: 'Bitcoin-Cash', index: i, addr: encodeCashAddr('bitcoincash', bchh) });

        // ── SUI ──
        const suiPriv  = slip10Ed25519(seed, `m/44'/784'/0'/0'/${i}'`);
        const suiPub   = ed25519.getPublicKey(suiPriv);
        const suiInput = new Uint8Array([0x00, ...suiPub]);
        const suiHash  = blake2b(suiInput, { dkLen: 32 });
        entries.push({ type: 'SUI', label: 'SUI', index: i, addr: '0x' + Buffer.from(suiHash).toString('hex') });

        // ── Solana (SOL) — SLIP-0010 Ed25519 m/44'/501'/i'/0' ──
        const solPriv = slip10Ed25519(seed, `m/44'/501'/${i}'/0'`);
        const solPub  = ed25519.getPublicKey(solPriv);
        const solAddr = base58.encode(Buffer.from(solPub));
        entries.push({ type: 'ECLIPSE',   label: 'Eclipse',   index: i, addr: solAddr });
        entries.push({ type: 'SONIC_SVM', label: 'Sonic-SVM', index: i, addr: solAddr });
        entries.push({ type: 'SOON',      label: 'SOON',      index: i, addr: solAddr });

        // ── XRP (Ripple) ──
        const xrpk       = root.derive(`m/44'/144'/0'/0/${i}`);
        const xrph       = ripemd160(sha256(xrpk.publicKey));
        const xrpPayload = new Uint8Array(21); xrpPayload[0] = 0x00; xrpPayload.set(xrph, 1);
        entries.push({ type: 'XRP', label: 'Ripple', index: i, addr: encodeRippleBase58Check(xrpPayload) });

        // ── Cosmos m/44'/118' — 10 شبكات من نفس المفتاح ──
        const cosk = root.derive(`m/44'/118'/0'/0/${i}`);
        const cosh = ripemd160(sha256(cosk.publicKey));
        for (const { type, label, pfx } of cosmosPrefixes)
            entries.push({ type, label, index: i, addr: bech32.encode(pfx, bech32.toWords(Buffer.from(cosh))) });

        // ── Injective (INJ) — m/44'/60', EVM-style keccak256, bech32 'inj' ──
        const injk    = root.derive(`m/44'/60'/0'/0/${i}`);
        const injUnc  = secp256k1.getPublicKey(injk.privateKey, false).slice(1);
        const injAddr = keccak_256(injUnc).slice(-20);
        entries.push({ type: 'INJ', label: 'Injective', index: i, addr: bech32.encode('inj', bech32.toWords(Buffer.from(injAddr))) });

        // ── Stellar (XLM) — SLIP-0010 Ed25519 ──
        const xlmPriv = slip10Ed25519(seed, `m/44'/148'/${i}'`);
        const xlmPub  = ed25519.getPublicKey(xlmPriv);
        entries.push({ type: 'XLM', label: 'Stellar', index: i, addr: encodeXLMAddress(xlmPub) });

        // ── Algorand (ALGO) — SLIP-0010 Ed25519 ──
        const algoPriv = slip10Ed25519(seed, `m/44'/283'/0'/0'/${i}'`);
        const algoPub  = ed25519.getPublicKey(algoPriv);
        entries.push({ type: 'ALGO', label: 'Algorand', index: i, addr: encodeALGOAddress(algoPub) });

        // ── NEAR Protocol — SLIP-0010 Ed25519 (implicit account = hex pubkey) ──
        const nearPriv = slip10Ed25519(seed, `m/44'/397'/${i}'`);
        const nearPub  = ed25519.getPublicKey(nearPriv);
        entries.push({ type: 'NEAR', label: 'NEAR', index: i, addr: Buffer.from(nearPub).toString('hex') });

        // ── MultiversX (EGLD) — SLIP-0010 Ed25519 ──
        const egldPriv = slip10Ed25519(seed, `m/44'/508'/0'/0'/${i}'`);
        const egldPub  = ed25519.getPublicKey(egldPriv);
        entries.push({ type: 'EGLD', label: 'MultiversX', index: i, addr: bech32.encode('erd', bech32.toWords(Buffer.from(egldPub))) });

        // ── Filecoin (FIL) — secp256k1 — f1... address ──
        const filk    = root.derive(`m/44'/461'/0'/0/${i}`);
        const filh    = ripemd160(sha256(filk.publicKey));
        const filPay  = new Uint8Array(filh.length + 1); filPay[0] = 0x01; filPay.set(filh, 1);
        const filChk  = (() => { let c = 0n; for (const b of filPay) { c += BigInt(b); } return []; })();
        // Filecoin f1: base32lower(pubkey_hash + checksum4)
        const filCrc  = (() => {
            const FILPOLY = 0xD5828281n;
            let crc = 0n;
            for (const b of filPay) {
                crc ^= BigInt(b) << 24n;
                for (let j = 0; j < 8; j++) crc = (crc & 0x80000000n) ? ((crc << 1n) ^ FILPOLY) & 0xFFFFFFFFn : (crc << 1n) & 0xFFFFFFFFn;
            }
            const c = Buffer.alloc(4); c.writeUInt32BE(Number(crc), 0); return c;
        })();
        const filFull = Buffer.concat([Buffer.from(filh), filCrc]);
        const FIL_B32 = 'abcdefghijklmnopqrstuvwxyz234567';
        let filBits = 0, filVal = 0, filStr = '';
        for (const b of filFull) { filVal = (filVal << 8) | b; filBits += 8; while (filBits >= 5) { filBits -= 5; filStr += FIL_B32[(filVal >>> filBits) & 0x1F]; } }
        if (filBits > 0) filStr += FIL_B32[(filVal << (5 - filBits)) & 0x1F];
        entries.push({ type: 'FIL', label: 'Filecoin', index: i, addr: 'f1' + filStr });

        // ── Hedera (HBAR) — Ed25519 SLIP-0010  m/44'/3030'/0'/0'/{i}' ──
        const hbarPriv   = slip10Ed25519(seed, `m/44'/3030'/0'/0'/${i}'`);
        const hbarPub    = ed25519.getPublicKey(hbarPriv);
        const hbarPubHex = Buffer.from(hbarPub).toString('hex');
        entries.push({ type: 'HBAR', label: 'Hedera', index: i, addr: hbarPubHex, pubhex: hbarPubHex });

        // ── Hedera (HBAR) — ECDSA secp256k1  m/44'/3030'/0'/0/{i} ──
        // كثير من المحافظ (Hashpack / Blade) تستخدم secp256k1 بدلاً من Ed25519
        const hbarSecpK  = root.derive(`m/44'/3030'/0'/0/${i}`);
        const hbarSecpHex= Buffer.from(hbarSecpK.publicKey).toString('hex');  // 33-byte compressed
        entries.push({ type: 'HBAR', label: 'Hedera-ECDSA', index: i, addr: hbarSecpHex, pubhex: hbarSecpHex });

        // ── Terra Classic (LUNC) — secp256k1 m/44'/330' ──
        const luncK = root.derive(`m/44'/330'/0'/0/${i}`);
        const luncH = ripemd160(sha256(luncK.publicKey));
        entries.push({ type: 'LUNC', label: 'Terra-Classic', index: i, addr: bech32.encode('terra', bech32.toWords(Buffer.from(luncH))) });

        // ── VeChain (VET) — secp256k1 m/44'/818' ──
        const vetk    = root.derive(`m/44'/818'/0'/0/${i}`);
        const vetUnc  = secp256k1.getPublicKey(vetk.privateKey, false).slice(1);
        const vetAddr = '0x' + Buffer.from(keccak_256(vetUnc).slice(-20)).toString('hex');
        entries.push({ type: 'VET', label: 'VeChain', index: i, addr: vetAddr });

        // ── Aptos (APT) — SLIP-0010 Ed25519 m/44'/637' ──
        const aptPriv  = slip10Ed25519(seed, `m/44'/637'/${i}'/0'/0'`);
        const aptPub   = ed25519.getPublicKey(aptPriv);
        const aptInput = new Uint8Array([...aptPub, 0x00]);
        entries.push({ type: 'APT', label: 'Aptos', index: i, addr: '0x' + Buffer.from(sha3_256(aptInput)).toString('hex') });

        // ── Substrate chains (Astar·Acala·Centrifuge·Parallel·Phala·Zeitgeist) ──
        const substrateChains = [
            { type: 'ASTR', label: 'Astar',      path: `m/44'/354'/0'/0'/${i}'`, prefix: 5  },
            { type: 'ACA',  label: 'Acala',      path: `m/44'/354'/0'/0'/${i}'`, prefix: 10 },
            { type: 'CFG',  label: 'Centrifuge', path: `m/44'/354'/0'/0'/${i}'`, prefix: 36 },
        ];
        for (const sc of substrateChains) {
            const scPriv = slip10Ed25519(seed, sc.path);
            const scPub  = ed25519.getPublicKey(scPriv);
            entries.push({ type: sc.type, label: sc.label, index: i,
                addr: encodeSubstrateAddress(scPub, sc.prefix),
                pubhex: Buffer.from(scPub).toString('hex') });
        }

        // ── EVM إضافي (شبكات غير موجودة في الأمر 6) — m/44'/60'/0'/0/i ──
        const evmk    = root.derive(`m/44'/60'/0'/0/${i}`);
        const evmUnc  = secp256k1.getPublicKey(evmk.privateKey, false).slice(1);
        const evmAddr = '0x' + Buffer.from(keccak_256(evmUnc).slice(-20)).toString('hex');
        // قائمة الشبكات محمّلة من chains.json
        const evmNets = CHAINS.evm_nets;
        for (const { type, label } of evmNets)
            entries.push({ type, label, index: i, addr: evmAddr });

        // ── Polkadot (DOT) — ed25519 SLIP-0010 m/44'/354' — SS58 prefix 0 ──
        const dotPriv = slip10Ed25519(seed, `m/44'/354'/0'/0'/${i}'`);
        const dotPub  = ed25519.getPublicKey(dotPriv);
        entries.push({ type: 'DOT', label: 'Polkadot', index: i,
            addr: encodeSubstrateAddress(dotPub, 0),
            pubhex: Buffer.from(dotPub).toString('hex') });

        // ── Kusama (KSM) — ed25519 SLIP-0010 m/44'/434' — SS58 prefix 2 ──
        const ksmPriv = slip10Ed25519(seed, `m/44'/434'/0'/0'/${i}'`);
        const ksmPub  = ed25519.getPublicKey(ksmPriv);
        entries.push({ type: 'KSM', label: 'Kusama', index: i,
            addr: encodeSubstrateAddress(ksmPub, 2),
            pubhex: Buffer.from(ksmPub).toString('hex') });

        // ── Zcash t1-address — m/44'/133'/0'/0/i — version [0x1c, 0xb8] ──
        const zeck = root.derive(`m/44'/133'/0'/0/${i}`);
        const zech = ripemd160(sha256(zeck.publicKey));
        const zecb = new Uint8Array(22); zecb[0] = 0x1c; zecb[1] = 0xb8; zecb.set(zech, 2);
        entries.push({ type: 'ZEC', label: 'Zcash', index: i, addr: bs58check.encode(zecb) });

        // ── Tezos (XTZ) — Ed25519 SLIP-0010 m/44'/1729'/i'/0' ──
        const xtzPriv = slip10Ed25519(seed, `m/44'/1729'/${i}'/0'`);
        const xtzPub  = ed25519.getPublicKey(xtzPriv);
        const xtzH    = blake2b(xtzPub, { dkLen: 20 });
        const xtzPay  = new Uint8Array(23);
        xtzPay[0] = 0x06; xtzPay[1] = 0xa1; xtzPay[2] = 0x9f;
        xtzH.forEach((b, j) => xtzPay[3 + j] = b);
        entries.push({ type: 'XTZ', label: 'Tezos', index: i, addr: bs58check.encode(xtzPay) });

        // ── Waves (WAVES) — Ed25519 SLIP-0010 m/44'/5741564'/0'/0'/i' ──
        const wavesPriv = slip10Ed25519(seed, `m/44'/5741564'/0'/0'/${i}'`);
        const wavesPub  = ed25519.getPublicKey(wavesPriv);
        const wavesKH   = keccak_256(blake2b(wavesPub, { dkLen: 32 })).slice(0, 20);
        const wavesBody = new Uint8Array([0x01, 0x57, ...wavesKH]);
        const wavesChk  = keccak_256(blake2b(wavesBody, { dkLen: 32 })).slice(0, 4);
        entries.push({ type: 'WAVES', label: 'Waves', index: i,
            addr: base58.encode(new Uint8Array([...wavesBody, ...wavesChk])) });

        // ── Stacks (STX) — secp256k1 m/44'/5757'/0'/0/i ──
        const stxKey  = root.derive(`m/44'/5757'/0'/0/${i}`);
        const stxH160 = ripemd160(sha256(stxKey.publicKey));
        entries.push({ type: 'STX', label: 'Stacks', index: i, addr: encodeC32Check(22, stxH160) });

        // ── Zilliqa (ZIL) — secp256k1 m/44'/313'/0'/0/i ──
        const zilKey  = root.derive(`m/44'/313'/0'/0/${i}`);
        const zilUnc  = secp256k1.getPublicKey(zilKey.privateKey, false).slice(1);
        const zilHex  = Buffer.from(keccak_256(zilUnc).slice(-20)).toString('hex');
        entries.push({ type: 'ZIL', label: 'Zilliqa', index: i,
            addr:    bech32.encode('zil', bech32.toWords(Buffer.from(zilHex, 'hex'))),
            addrHex: zilHex });

        // ── TON WalletV4R2 — Ed25519 SLIP-0010 (Tonkeeper: m/44'/607'/i') ──
        const tonPriv = slip10Ed25519(seed, `m/44'/607'/${i}'`);
        const tonPub  = ed25519.getPublicKey(tonPriv);
        entries.push({ type: 'TON', label: 'TON', index: i, addr: encodeTONv4(tonPub) });

        // ── ICON (ICX) — secp256k1 m/44'/74'/0'/0/i — hx + keccak256[-20:] ──
        const icxk   = root.derive(`m/44'/74'/0'/0/${i}`);
        const icxUnc = secp256k1.getPublicKey(icxk.privateKey, false).slice(1);
        entries.push({ type: 'ICX', label: 'ICON', index: i,
            addr: 'hx' + Buffer.from(keccak_256(icxUnc).slice(-20)).toString('hex') });

        // ── Nano (XNO) — SLIP-0010 Ed25519 m/44'/165'/i' ──
        const xnoPriv = slip10Ed25519(seed, `m/44'/165'/${i}'`);
        const xnoPub  = ed25519.getPublicKey(xnoPriv);
        const xnoChk  = blake2b(Buffer.from(xnoPub), { dkLen: 5 });
        entries.push({ type: 'XNO', label: 'Nano', index: i,
            addr: encodeNanoAddress(xnoPub, Buffer.from(xnoChk).reverse()) });

        // ── NEO3 — secp256k1 m/44'/888'/0'/0/i ──
        const neo3k      = root.derive(`m/44'/888'/0'/0/${i}`);
        const neo3Script = Buffer.concat([
            Buffer.from([0x0c, 0x21]),
            Buffer.from(neo3k.publicKey),
            Buffer.from([0x41, 0x56, 0xe7, 0xb3, 0x27])
        ]);
        const neo3Hash   = Buffer.from(ripemd160(sha256(neo3Script))).reverse();
        const neo3Pay    = new Uint8Array(21); neo3Pay[0] = 0x35; neo3Hash.forEach((b, j) => neo3Pay[j + 1] = b);
        entries.push({ type: 'NEO', label: 'NEO3', index: i, addr: bs58check.encode(neo3Pay) });

        // ── Nervos CKB — secp256k1 m/44'/309'/0'/0/i — bech32 ckb ──
        const ckbk    = root.derive(`m/44'/309'/0'/0/${i}`);
        const ckbArgs = Buffer.from(blake2b(Buffer.from(ckbk.publicKey), { dkLen: 32 })).slice(0, 20);
        const ckbPay  = Buffer.concat([Buffer.from([0x01, 0x00]), ckbArgs]);
        entries.push({ type: 'CKB', label: 'Nervos-CKB', index: i,
            addr:    bech32.encode('ckb', bech32.toWords(ckbPay)),
            ckbArgs: '0x' + ckbArgs.toString('hex') });

        // ── Cardano (ADA) — SLIP-0010 Ed25519 m/1852'/1815'/0'/0/i — Enterprise addr ──
        const adaPriv = slip10Ed25519(seed, `m/1852'/1815'/0'/0/${i}`);
        const adaPub  = ed25519.getPublicKey(adaPriv);
        const adaHash = blake2b(Buffer.from(adaPub), { dkLen: 28 }); // blake2b-224
        const adaPay  = new Uint8Array(29); adaPay[0] = 0x61; adaHash.forEach((b, j) => adaPay[j + 1] = b);
        entries.push({ type: 'ADA', label: 'Cardano', index: i,
            addr: bech32.encode('addr', bech32.toWords(Buffer.from(adaPay)), false) });
    }

    return entries;
}

// ── جلب أسعار كل الشبكات: OKX + Binance + CoinGecko بالتوازي ──
// الأولوية: OKX → Binance → CoinGecko (كل مصدر يملأ الفراغات فقط)
async function fetchAllRpcPrices() {

    // ── أسعار OKX / Binance / CoinGecko — محمّلة من chains.json ──
    const okxCoins     = CHAINS.okx.price_tickers;
    const binanceCoins = CHAINS.prices_binance;
    const cgMap        = CHAINS.prices_coingecko;

    const prices = {};

    // ── جلب الأربعة بالتوازي: OKX + Binance + CoinGecko + Gate.io ──
    // Gate.io: خريطة رمز → زوج تداول (للعملات الصغيرة غير المدرجة في المصادر الأخرى)
    const GATE_PAIRS = {
        MTR: 'MTR_USDT', HSK: 'HSK_USDT', U2U: 'U2U_USDT', IOST: 'IOST_USDT',
        SDN: 'SDN_USDT', NRG: 'NRG_USDT', VTRU: 'VTRU_USDT', ELY: 'ELY_USDT',
        VINU: 'VINU_USDT', ESC: 'ESC_USDT', ETN: 'ETN_USDT', XFI: 'XFI_USDT',
        MEER: 'MEER_USDT', GO: 'GO_USDT', IOTA_EVM: 'IOTA_USDT', PLUME: 'PLUME_USDT',
        IP: 'IP_USDT', BERA: 'BERA_USDT', IMX: 'IMX_USDT', WEMIX: 'WEMIX_USDT',
        CORE: 'CORE_USDT', LSK: 'LSK_USDT', TAO_EVM: 'TAO_USDT', SOPH: 'SOPH_USDT',
        MONAD: 'MON_USDT', XDC: 'XDC_USDT', SIX: 'SIX_USDT', PLATON: 'LAT_USDT',
        GLQ: 'GLQ_USDT', AIOZ: 'AIOZ_USDT', RLC: 'RLC_USDT', VANA: 'VANA_USDT',
        DYM: 'DYM_USDT', SAGA: 'SAGA_USDT', MERLIN: 'MERL_USDT', IMX: 'IMX_USDT',
        CHZ: 'CHZ_USDT', RON: 'RON_USDT', TLOS: 'TLOS_USDT', CANTO: 'CANTO_USDT',
        OKT: 'OKT_USDT', GT: 'GT_USDT',
    };

    const [_okx, binData, cgData, gateData] = await Promise.all([
        // OKX
        Promise.all(Object.entries(okxCoins).map(async ([sym, instId]) => {
            try {
                const r = await axios.get(
                    `https://www.okx.com/api/v5/market/ticker?instId=${instId}`,
                    { timeout: 8000 }
                );
                const p = parseFloat(r.data.data?.[0]?.last || 0);
                if (p > 0) prices[sym] = p;
            } catch (_) {}
        })),
        // Binance
        Promise.all(Object.entries(binanceCoins).map(async ([sym, pair]) =>
            axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`, { timeout: 8000 })
                .then(r => ({ sym, p: parseFloat(r.data.price || 0) }))
                .catch(() => ({ sym, p: 0 }))
        )),
        // CoinGecko
        axios.get(
            `https://api.coingecko.com/api/v3/simple/price?ids=${Object.keys(cgMap).join(',')}&vs_currencies=usd`,
            { timeout: 12000 }
        ).then(r => r.data).catch(() => ({})),
        // Gate.io — جلب كل الأسعار دفعة واحدة (أكفأ من طلبات فردية)
        axios.get('https://api.gateio.ws/api/v4/spot/tickers', { timeout: 10000 })
            .then(r => {
                const map = {};
                r.data.forEach(t => { map[t.currency_pair] = parseFloat(t.last || 0); });
                return map;
            }).catch(() => ({})),
    ]);

    // Binance يملأ الفراغات (لا يُلغي OKX)
    for (const { sym, p } of binData) {
        if (p > 0 && !prices[sym]) prices[sym] = p;
    }
    // FRAX / SOON = ETH — Fraxtal & SOON SVM use ETH as native gas
    if (!prices.FRAX     && prices.ECLIPSE)   prices.FRAX     = prices.ECLIPSE;
    if (!prices.SOON     && prices.ECLIPSE)   prices.SOON     = prices.ECLIPSE;
    // SONIC_SVM = SOL — Sonic SVM uses SOL as native gas
    if (!prices.SONIC_SVM && prices.SOL)      prices.SONIC_SVM = prices.SOL;

    // CoinGecko يملأ ما تبقى
    Object.entries(cgData).forEach(([id, v]) => {
        const sym = cgMap[id];
        if (sym && v?.usd > 0 && !prices[sym]) prices[sym] = v.usd;
    });

    // Gate.io يملأ ما تبقى من الفراغات
    for (const [sym, pair] of Object.entries(GATE_PAIRS)) {
        if (!prices[sym] && gateData[pair] > 0) prices[sym] = gateData[pair];
    }

    // ── DeFiLlama: أسعار شبكات EVM عبر CoinGecko IDs ──
    // خريطة رمز الشبكة → CoinGecko ID (لا تحتاج صيانة يدوية)
    const LLAMA_MAP = {
        // ── الرئيسية ──
        ETH:      'ethereum',          KAIA:     'kaia',
        MANTLE:   'mantle',            FLOW:     'flow',
        CFX:      'conflux-token',     THETA:    'theta-token',
        PEAQ:     'peaq-2',            MANTA:    'manta-network',
        GLQ:      'graphlinq-protocol',TT:       'thunder-token',
        APE:      'apecoin',           BTT:      'bittorrent',
        CHZ:      'chiliz',            ZRC:      'zircuit',
        VANA:     'vana',              CAM:      'camino-network',
        ZKLINK:   'zklink',            ZKFAIR:   'zkfair',
        LYX:      'lukso-token-2',     SGB:      'songbird',
        RING:     'darwinia-network-native-token',
        KUB:      'bitkub-coin',       VLX:      'velas',
        RLC:      'iexec-rlc',         SMR:      'shimmer',
        AIOZ:     'aioz-network',      META:     'metadium',
        ONT:      'ontology',          PLATON:   'platon-network',
        DEGEN:    'degen-base',        DYM:      'dymension',
        SAGA:     'saga-2',            BEAM:     'beam-2',
        SEI_EVM:  'sei-network',       CYBER:    'cyber',
        OKT:      'okex-token',
        // ── شبكات أُضيفت: تحتاج CoinGecko ID عبر DeFiLlama ──
        EMERALD:  'oasis-network',     SAPPHIRE: 'oasis-network',
        XPLA:     'xpla',              XDC:      'xdce-crowd-sale',
        GO:       'gochain',           MTR:      'meter-governance',
        GT:       'gatechain-token',   HSK:      'hashkey-token',
        SIX:      'six-network',       U2U:      'u2u-network',
        DEL:      'decimal',           PLUME:    'plume',
        IP:       'story-2',           BERA:     'berachain-bera',
        IOTA_EVM: 'iota',              LSK:      'lisk',
        NRG:      'energi',            TAO_EVM:  'bittensor',
        SDN:      'shiden-network',    SOPH:     'sophon',
        ETN:      'electroneum',       XFI:      'crossfi-2',
        MEER:     'qitmeer',           TNET:     'tenet-1',
        ELY:      'elysia',            VINU:     'vita-inu',
        ABEY:     'abeychain',         IOST:     'iost',
        ESC:      'elastos',           IMX:      'immutable-x',
        WEMIX:    'wemix-token',       CORE:     'coredaoorg',
        VTRU:     'vitruveo',          ZKCRO:    'crypto-com-chain',
        GRAVITY:  'graviton-zero',     MONAD:    'monad',
        HELA:     'hela-network',      CANTO:    'canto',
        RON:      'ronin',             TLOS:     'telos',
        DFK:      'jewel',             NEON:     'neon',
        WATER:    'waterfall-network', ACA_EVM:  'acala',
        TAC:      'tac-2',             XLAYER:   'okex-token',
        MERLIN:   'merlin-chain',      XTZ:      'tezos',
        WAVES:    'waves',             ZIL:      'zilliqa',
        IOST:     'iost',             SCRT:      'secret',
        // ── شبكات الأمر 6 ──
        BNB:      'binancecoin',      GNO:      'gnosis',
        POL:      'matic-network',    FTM:      'fantom',
        GLMR:     'moonbeam',         CRO:      'crypto-com-chain',
        CELO:     'celo',             AVAX:     'avalanche-2',
        ETC:      'ethereum-classic', FLR:      'flare-networks',
        KCS:      'kucoin-shares',    METIS:    'metis-token',
        BOBA:     'boba-network',     MOVR:     'moonriver',
        ACE:      'fusionist',        KAVA:     'kava',
        PLS:      'pulsechain',       ISLM:     'islamic-coin',
    };
    const missingSyms = Object.keys(LLAMA_MAP).filter(s => !prices[s]);
    if (missingSyms.length > 0) {
        const uniqueIds = [...new Set(missingSyms.map(s => 'coingecko:' + LLAMA_MAP[s]))];
        try {
            const lr = await axios.get(
                'https://coins.llama.fi/prices/current/' + uniqueIds.join(','),
                { timeout: 12000 }
            );
            const llamaCoins = lr.data.coins || {};
            for (const sym of missingSyms) {
                const key = 'coingecko:' + LLAMA_MAP[sym];
                if (llamaCoins[key]?.price > 0 && !prices[sym])
                    prices[sym] = llamaCoins[key].price;
            }
        } catch (_) {}
    }

    // ── أسعار مشتقة: عملات تستخدم نفس الرمز الأصلي لشبكة أخرى ──
    // FIL_EVM = FIL (Filecoin EVM تستخدم FIL كعملة أصلية)
    if (!prices.FIL_EVM  && prices.FIL)  prices.FIL_EVM  = prices.FIL;
    // XTZ_EVM = XTZ (Etherlink تستخدم XTZ)
    if (!prices.XTZ_EVM  && prices.XTZ)  prices.XTZ_EVM  = prices.XTZ;
    // NIBI_EVM = NIBI (Nibiru EVM تستخدم NIBI)
    if (!prices.NIBI_EVM && prices.NIBI) prices.NIBI_EVM = prices.NIBI;
    // XRPL_EVM = XRP (XRPL EVM تستخدم XRP)
    if (!prices.XRPL_EVM && prices.XRP)  prices.XRPL_EVM = prices.XRP;
    // ROLLUX = SYS (Rollux هي Syscoin L2)
    if (!prices.ROLLUX   && prices.SYS)  prices.ROLLUX   = prices.SYS;
    // OPBNB = BNB (opBNB تستخدم BNB كعملة أصلية)
    if (!prices.OPBNB    && prices.BNB)  prices.OPBNB    = prices.BNB;
    // RBTC = BTC (Rootstock تستخدم BTC كعملة أصلية)
    if (!prices.RBTC     && prices.BTC)  prices.RBTC     = prices.BTC;
    // ZG = 0G network - native token A0GI
    if (!prices.ZG) {
        try {
            const zgR = await axios.get(
                'https://coins.llama.fi/prices/current/coingecko:zero-gravity-2',
                { timeout: 6000 }
            );
            const zgP = zgR.data?.coins?.['coingecko:zero-gravity-2']?.price;
            if (zgP > 0) prices.ZG = zgP;
        } catch (_) {}
    }

    // ── شبكات Bitcoin L2 تستخدم BTC كعملة أصلية ──
    const BTC_L2 = ['AIL', 'BTC_BOT', 'GOAT', 'MEZO', 'BITLAYER', 'B2'];
    if (prices.BTC) {
        for (const sym of BTC_L2)
            if (!prices[sym]) prices[sym] = prices.BTC;
    }

    // ── شبكات L2 تستخدم ETH كعملة أصلية ──
    const ETH_L2 = [
        'INK','SONEIUM','ZORA','BLAST','LINEA','TAIKO','SCROLL',
        'UNI_EVM','ETH_SWELL','ABS','HEMI','WLD','MEGA','KAT',
        'BLEND','FRAX','REYA','LENS','MORPH',
        // شبكات الأمر 6 التي تستخدم ETH
        'OP','ZKS','PZKEVM','BASE','ARB','AURORA','ARB_NOVA','BOB','MODE',
    ];
    if (prices.ETH) {
        for (const sym of ETH_L2)
            if (!prices[sym]) prices[sym] = prices.ETH;
    }

    return prices;
}

// ── مساعد: أول استجابة ناجحة من عدة endpoints بالتوازي ──
// ينتظر الانتهاء الفعلي — لا يقطع أي شبكة بسبب timeout
function raceSuccess(promises) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (val) => { if (!done) { done = true; resolve(val); } };
        let remaining = promises.length;
        if (remaining === 0) { finish(null); return; }
        for (const p of promises) {
            Promise.resolve(p)
                .then(result => {
                    if (result !== null && result !== undefined) finish(result);
                })
                .catch(() => {})
                .finally(() => { if (--remaining === 0) finish(null); });
        }
    });
}

// ── RPC: Bitcoin — مُسلسَل (250ms بين الطلبات) لتجنب rate-limit بعد 25+ عبارة ──
async function rpcBTC(addr) {
    const parse = (r) => {
        const s = r.data.chain_stats;
        return { balance: (s.funded_txo_sum - s.spent_txo_sum) / 1e8, txCount: s.tx_count };
    };
    return throttled('btc', () => raceSuccess([
        axios.get(`https://blockstream.info/api/address/${addr}`, { timeout: 60000 }).then(parse).catch(() => null),
        axios.get(`https://mempool.space/api/address/${addr}`,    { timeout: 60000 }).then(parse).catch(() => null),
    ]), 250);
}

// ── RPC: LTC / DOGE / DASH / BCH ──
async function rpcBlockcypher(addr, coin) {
    // ── LTC: litecoinspace (✅ 30/30 متوازي) ──
    if (coin === 'ltc') {
        return raceSuccess([
            axios.get(`https://litecoinspace.org/api/address/${addr}`, { timeout: 60000 })
                .then(r => {
                    const s = r.data?.chain_stats || {};
                    return { balance: ((s.funded_txo_sum || 0) - (s.spent_txo_sum || 0)) / 1e8, txCount: s.tx_count || 0 };
                }).catch(e => (e.response?.status === 404 ? { balance: 0, txCount: 0 } : null)),
        ]);
    }

    // ── BCH: fullstack.cash (✅ 20/20 متوازي) ──
    if (coin === 'bch') {
        const cashAddr = addr.startsWith('bitcoincash:') ? addr : `bitcoincash:${addr}`;
        return axios.get(`https://api.fullstack.cash/v5/address/details/${cashAddr}`, { timeout: 60000 })
            .then(r => ({ balance: (r.data.balance ?? 0) + (r.data.unconfirmedBalance ?? 0), txCount: r.data.txCount ?? 0 }))
            .catch(() => null);
    }

    // ── DOGE: مُوقَّف مؤقتاً — جميع APIs تُطلق 429/430 (BlockCypher·Blockchair·SoChain·DogeChain) ──
    if (coin === 'doge') {
        return { balance: 0, txCount: 0, _paused: true };
    }

    // ── DASH: مُسلسَل لتجنب 429 ──
    if (coin === 'dash') {
        return throttled('dash', () =>
            raceSuccess([
                axios.get(`https://api.blockcypher.com/v1/dash/main/addrs/${addr}/balance`, { timeout: 60000 })
                    .then(r => ({ balance: r.data.final_balance / 1e8, txCount: r.data.n_tx }))
                    .catch(() => null),
                axios.get(`https://chainz.cryptoid.info/dash/api.dws?q=getbalance&a=${addr}`, { timeout: 60000 })
                    .then(r => { const b = parseFloat(r.data); return isNaN(b) ? null : { balance: b, txCount: 0 }; })
                    .catch(() => null),
            ])
        , 380).catch(() => null);
    }

    return null;
}

// ── RPC: TRX — TronGrid wallet/getaccount (مُسلسَل لتجنب rate-limit) ──
async function rpcTRX(addr) {
    return throttled('trx', async () => {
        // /wallet/getaccount تقبل base58 (T...) مباشرةً
        const r = await axios.post(
            'https://api.trongrid.io/wallet/getaccount',
            { address: addr },
            { timeout: 60000 }
        );
        const d = r.data;
        if (!d || d.Error || (!d.balance && !d.address)) return { balance: 0, txCount: 0 };
        const bal = parseInt(d.balance || 0);
        const txCount = d.transaction_count || (d.balance > 0 ? 1 : 0);
        return { balance: bal / 1e6, txCount };
    }, 420).catch(() => null);
}

// ── RPC: SOL / شبكات SVM — race بين الـ endpoints بدون timer قاطع ──
async function rpcSOL(addr, endpoints = ['https://api.mainnet-beta.solana.com']) {
    const tryOne = (ep) =>
        axios.post(ep, {
            jsonrpc: '2.0', id: 1,
            method: 'getBalance',
            params: [addr, { commitment: 'confirmed' }],
        }, { timeout: 60000 }).then(r => {
            const lamports = r.data.result?.value ?? r.data.result ?? 0;
            return { balance: Number(lamports) / 1e9, txCount: 0 };
        });
    return raceSuccess(endpoints.map(ep => tryOne(ep).catch(() => null)));
}

// ── RPC: SUI — race بين عدة fullnodes ──
async function rpcSUI(addr) {
    const SUI_EPS = [
        'https://rpc.mainnet.sui.io',        // 91ms ✅ (الأسرع)
        'https://fullnode.mainnet.sui.io',
        // ❌ sui-mainnet.publicnode.com → HTTP 404 معطوب تماماً
    ];
    const tryOne = (ep) =>
        axios.post(ep, {
            jsonrpc: '2.0', id: 1,
            method: 'suix_getBalance',
            params: [addr, '0x2::sui::SUI'],
        }, { timeout: 60000 }).then(r => {
            const mist = Number(BigInt(r.data.result?.totalBalance || '0'));
            return { balance: mist / 1e9, txCount: 0 };
        });
    return raceSuccess(SUI_EPS.map(ep => tryOne(ep).catch(() => null)));
}

// Agent خاص للشبكات التي تحتاج تجاهل شهادة SSL (مُشترك — يُنشأ مرة واحدة فقط)
const RPC_HTTPS_AGENT_NOSSL = new https.Agent({ keepAlive: true, maxSockets: Infinity, maxFreeSockets: 64, rejectUnauthorized: false });

// ── RPC: EVM — race بين الـ endpoints بدون timer قاطع ──
async function rpcEVM(addr, endpoints, noSslVerify = false, timeoutMs = 60000) {
    // استخدام الـ agents المُشتركة بدل إنشاء agent جديد لكل طلب
    const agentOpts = {
        httpAgent:  RPC_HTTP_AGENT,
        httpsAgent: noSslVerify ? RPC_HTTPS_AGENT_NOSSL : RPC_HTTPS_AGENT,
    };

    const NETWORK_ERRORS = new Set(['ECONNABORTED','ETIMEDOUT','ENOTFOUND','ECONNREFUSED','ECONNRESET','ERR_NETWORK']);

    const tryOne = async (ep) => {
        const opts = { timeout: timeoutMs, ...agentOpts };
        // محاولة batch أولاً (طلب واحد يجلب الرصيد + النشاط)
        try {
            const r = await axios.post(ep, [
                { jsonrpc: '2.0', id: 1, method: 'eth_getBalance',          params: [addr, 'latest'] },
                { jsonrpc: '2.0', id: 2, method: 'eth_getTransactionCount', params: [addr, 'latest'] },
            ], opts);
            const arr = Array.isArray(r.data) ? r.data : null;
            if (arr && arr.length >= 1) {
                const balHex  = arr.find(x => x.id === 1)?.result;
                const nonceHx = arr.find(x => x.id === 2)?.result;
                const balance = (balHex  && balHex  !== '0x' && balHex  !== '0x0')
                    ? Number(BigInt(balHex))  / 1e18 : 0;
                const txCount = (nonceHx && nonceHx !== '0x' && nonceHx !== '0x0')
                    ? Number(BigInt(nonceHx)) : 0;
                return { balance, txCount };
            }
            // الرد ليس مصفوفة → الرابط لا يدعم batch → fallback للطلبين المنفصلين
        } catch (err) {
            // خطأ شبكة أو timeout → لا تُجرّب مجدداً (دع raceSuccess ينتقل للرابط التالي)
            if (NETWORK_ERRORS.has(err.code) || err.response?.status >= 500) throw err;
            // خطأ آخر (batch غير مدعوم) → fallback
        }

        // fallback: طلبان منفصلان بالتوازي (لا يُضيفان وقتاً إضافياً)
        const [balR, nncR] = await Promise.all([
            axios.post(ep, { jsonrpc:'2.0', id:1, method:'eth_getBalance',
                params:[addr,'latest'] }, opts).then(r => r.data.result).catch(() => null),
            axios.post(ep, { jsonrpc:'2.0', id:2, method:'eth_getTransactionCount',
                params:[addr,'latest'] }, opts).then(r => r.data.result).catch(() => null),
        ]);
        if (balR === null && nncR === null) return null;
        const balance = (balR && balR !== '0x' && balR !== '0x0')
            ? Number(BigInt(balR))  / 1e18 : 0;
        const txCount = (nncR && nncR !== '0x' && nncR !== '0x0')
            ? Number(BigInt(nncR)) : 0;
        return { balance, txCount };
    };

    return raceSuccess(endpoints.map(ep => tryOne(ep).catch(() => null)));
}

// ── RPC: EVM Batch — يُرسل N عنوان في طلب JSON-RPC batch واحد لكل شبكة ──
// يُعيد: { balances: (number|null)[], mode: 'batch'|'individual'|'failed', ep, err? }
async function rpcEVMBatch(addrs, endpoints, noSslVerify = false, timeoutMs = 2500) {
    const agentOpts = {
        httpAgent:  RPC_HTTP_AGENT,
        httpsAgent: noSslVerify ? RPC_HTTPS_AGENT_NOSSL : RPC_HTTPS_AGENT,
    };
    const FAIL = (err) => ({ balances: new Array(addrs.length).fill(null), mode: 'failed', ep: endpoints[0], err });

    for (const ep of endpoints) {
        // ── محاولة 1: batch JSON-RPC (كل العناوين في طلب واحد) ──
        try {
            const batchReq = addrs.map((addr, i) => ({
                jsonrpc: '2.0', id: i, method: 'eth_getBalance', params: [addr, 'latest']
            }));
            const r = await axios.post(ep, batchReq, { timeout: timeoutMs, ...agentOpts });
            const arr = Array.isArray(r.data) ? r.data : null;
            // مصفوفة فيها items بـ id = batch مدعوم (حتى لو كان الرد error بدل result)
            if (arr && arr.length > 0 && arr.some(item => item?.id !== undefined)) {
                const balances = new Array(addrs.length).fill(null);
                for (const item of arr) {
                    if (item?.id !== undefined && item.id >= 0 && item.id < addrs.length) {
                        if (item.result !== undefined) {
                            try {
                                balances[item.id] = (item.result && item.result !== '0x' && item.result !== '0x0')
                                    ? Number(BigInt(item.result)) / 1e18 : 0;
                            } catch { balances[item.id] = 0; }
                        } else if (item.error !== undefined) {
                            // خطأ "not found" = رصيد صفري على هذه الشبكة (مثل EVA)
                            balances[item.id] = 0;
                        }
                    }
                }
                return { balances, mode: 'batch', ep };
            }
            // الرد ليس مصفوفة → الرابط لا يدعم batch → fallback
        } catch (err) {
            const code = err.code || err.response?.status;
            // خطأ شبكة → جرّب الرابط التالي
            if (['ECONNABORTED','ETIMEDOUT','ENOTFOUND','ECONNREFUSED','ECONNRESET','ERR_NETWORK'].includes(err.code)
                || err.response?.status >= 500) {
                continue;
            }
            // خطأ آخر (batch غير مدعوم) → fallback individual على نفس الرابط
        }

        // ── محاولة 2: طلبات فردية متوازية على نفس الـ endpoint ──
        try {
            const balances = await Promise.all(addrs.map(async (addr) => {
                try {
                    const r = await axios.post(ep,
                        { jsonrpc:'2.0', id:1, method:'eth_getBalance', params:[addr,'latest'] },
                        { timeout: timeoutMs, ...agentOpts }
                    );
                    const result = r.data?.result;
                    if (result === undefined || result === null) return null;
                    return (result !== '0x' && result !== '0x0') ? Number(BigInt(result)) / 1e18 : 0;
                } catch { return null; }
            }));
            if (balances.some(b => b !== null)) return { balances, mode: 'individual', ep };
        } catch { /* جرّب الرابط التالي */ }
    }

    return FAIL(`timeout/error on all endpoints`);
}

// ── RPC: DOT / KSM (Substrate state_getStorage) ──
async function rpcDOT(pubhex, isKSM = false) {
    const { blake2b } = require('@noble/hashes/blake2');
    const SYS_KEY = '26aa394eea5630e07c48ae0c9558cef7';
    const ACC_KEY = 'b99d880ec681799c0cf30e8886371da9';
    const pub     = Buffer.from(pubhex, 'hex');
    const b128    = Buffer.from(blake2b(pub, { dkLen: 16 })).toString('hex');
    const storKey = '0x' + SYS_KEY + ACC_KEY + b128 + pubhex;
    const eps = isKSM
        ? ['https://kusama-rpc.polkadot.io', 'https://kusama-rpc.publicnode.com']
        : ['https://rpc.polkadot.io',        'https://polkadot-rpc.publicnode.com'];
    const dec = isKSM ? 12 : 10;
    const parseR = (r) => {
        const hex = r.data.result;
        if (!hex || hex === '0x' || hex === null) return { balance: 0, txCount: 0 };
        const buf = Buffer.from(hex.slice(2), 'hex');
        if (buf.length < 32) return { balance: 0, txCount: 0 };
        const freeLo = buf.readBigUInt64LE(16);
        const freeHi = buf.readBigUInt64LE(24);
        const free   = freeLo + freeHi * (2n ** 64n);
        return { balance: Number(free) / (10 ** dec), txCount: 0 };
    };
    const tryOne = (ep) =>
        axios.post(ep, { jsonrpc: '2.0', id: 1, method: 'state_getStorage', params: [storKey] },
            { timeout: 60000 }).then(parseR);
    return raceSuccess(eps.map(ep => tryOne(ep).catch(() => null)));
}

// ── RPC: ZEC (Zcash — مُسلسَل: blockexplorer.one أولاً) ──
// ⚠️ مُوقَّف مؤقتاً: جميع APIs العامة تُفشل تحت الضغط (blockchair 430، chainz 404)
async function rpcZEC(_addr) {
    return { balance: 0, txCount: 0, _paused: true };
}

// ── RPC: XTZ (Tezos — TzKT REST API) ──
async function rpcXTZ(addr) {
    return raceSuccess([
        axios.get(`https://api.tzkt.io/v1/accounts/${addr}`, { timeout: 60000 })
            .then(r => ({ balance: (r.data.balance || 0) / 1e6, txCount: r.data.numTransactions || 0 }))
            .catch(e => (e.response?.status === 404 ? { balance: 0, txCount: 0 } : null)),
    ]);
}

// ── RPC: WAVES (Waves Node API) ──
async function rpcWAVES(addr) {
    const parse = r => ({ balance: (r.data.available ?? r.data.regular ?? r.data.balance ?? 0) / 1e8, txCount: 0 });
    return raceSuccess([
        axios.get(`https://nodes.wavesnodes.com/addresses/balance/details/${addr}`, { timeout: 60000 })
            .then(parse).catch(e => (e.response?.status === 404 ? { balance: 0, txCount: 0 } : null)),
        axios.get(`https://nodes.waves.exchange/addresses/balance/details/${addr}`, { timeout: 60000 })
            .then(parse).catch(() => null),
    ]);
}

// ── RPC: STX (Stacks Blockchain API — Hiro) ──
async function rpcSTX(addr) {
    return raceSuccess([
        axios.get(`https://api.mainnet.hiro.so/v2/accounts/${addr}?proof=0`, { timeout: 60000 })
            .then(r => {
                const bal = Number(BigInt(r.data.balance || '0x0')) / 1e6;
                return { balance: bal, txCount: r.data.nonce || 0 };
            })
            .catch(e => (e.response?.status === 404 ? { balance: 0, txCount: 0 } : null)),
    ]);
}

// ── RPC: ZIL (Zilliqa JSON-RPC — GetBalance) ──
async function rpcZIL(hexAddr) {
    const clean = hexAddr.replace(/^0x/, '').toLowerCase();
    const body  = { id: '1', jsonrpc: '2.0', method: 'GetBalance', params: [clean] };
    return raceSuccess([
        axios.post('https://api.zilliqa.com', body, { timeout: 60000 })
            .then(r => {
                if (r.data.error) return { balance: 0, txCount: 0 };
                const qa = r.data.result?.balance || '0';
                return { balance: Number(BigInt(qa)) / 1e12, txCount: r.data.result?.nonce || 0 };
            })
            .catch(() => ({ balance: 0, txCount: 0 })),
    ]);
}


// ── RPC: TON (TonCenter v3 + TonAPI) ──
// APIs ترفض UQ.../EQ... base64 — تحتاج صيغة "0:hex" (raw hash) ──
async function rpcTON(addr) {
    // تحويل base64url → 0:hex
    let hexAddr = addr;
    if (!addr.startsWith('0:')) {
        try {
            const raw = Buffer.from(addr.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
            hexAddr = '0:' + raw.slice(2, 34).toString('hex');
        } catch { hexAddr = addr; }
    }
    const enc = encodeURIComponent(hexAddr);
    return raceSuccess([
        axios.get(`https://toncenter.com/api/v3/account?address=${enc}`, { timeout: 60000 })
            .then(r => {
                // v3 يُرجع balance مباشرة (بدون address للمحافظ غير المُفعّلة)
                if (r.data.balance === undefined) return { balance: 0, txCount: 0 };
                return { balance: Number(BigInt(r.data.balance || '0')) / 1e9, txCount: 0 };
            })
            .catch(e => (e.response?.status === 404 ? { balance: 0, txCount: 0 } : null)),
        axios.get(`https://tonapi.io/v2/accounts/${enc}`, { timeout: 60000 })
            .then(r => ({ balance: Number(r.data.balance || 0) / 1e9, txCount: r.data.last_activity ? 1 : 0 }))
            .catch(() => null),
    ]);
}

// ── RPC: XLM (Stellar Horizon) ──
async function rpcXLM(addr) {
    return raceSuccess([
        axios.get(`https://horizon.stellar.org/accounts/${addr}`, { timeout: 60000 })
            .then(r => {
                const xlm = r.data.balances?.find(b => b.asset_type === 'native');
                return { balance: parseFloat(xlm?.balance || 0), txCount: parseInt(r.data.sequence || 0) };
            })
            .catch(e => (e.response?.status === 404 ? { balance: 0, txCount: 0 } : null)),
    ]);
}

// ── RPC: ALGO (AlgoNode mainnet) ──
async function rpcALGO(addr) {
    return raceSuccess([
        axios.get(`https://mainnet-api.algonode.cloud/v2/accounts/${addr}`, { timeout: 60000 })
            .then(r => ({ balance: (r.data.amount || 0) / 1e6, txCount: r.data['total-created-assets'] || 0 }))
            .catch(e => (e.response?.status === 404 ? { balance: 0, txCount: 0 } : null)),
    ]);
}

// ── RPC: NEAR (NEAR mainnet JSON-RPC) ──
async function rpcNEAR(addr) {
    const body = { jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: addr } };
    const tryOne = (ep) =>
        axios.post(ep, body, { timeout: 60000 }).then(r => {
            if (r.data.error || r.data.result?.code_hash === undefined) return { balance: 0, txCount: 0 };
            const yocto = r.data.result?.amount || '0';
            return { balance: Number(BigInt(yocto)) / 1e24, txCount: 0 };
        });
    return raceSuccess([
        tryOne('https://rpc.mainnet.near.org').catch(() => null),
        tryOne('https://free.rpc.fastnear.com').catch(() => null),
    ]);
}

// ── RPC: EGLD (MultiversX REST) ──
async function rpcEGLD(addr) {
    return raceSuccess([
        axios.get(`https://api.multiversx.com/accounts/${addr}`, { timeout: 60000 })
            .then(r => ({ balance: parseInt(r.data.balance || 0) / 1e18, txCount: r.data.txCount || 0 }))
            .catch(e => (e.response?.status === 404 ? { balance: 0, txCount: 0 } : null)),
    ]);
}

// ── RPC: HBAR (Hedera Mirror Node) — بحث عكسي بالمفتاح العام ──
// يبحث بـ Ed25519 (32-byte raw hex) ثم secp256k1 (33-byte compressed)
async function rpcHBAR(pubhex) {
    const MIRRORS = [
        'https://mainnet-public.mirrornode.hedera.com',
        'https://mainnet.mirrornode.hedera.com',
    ];
    const TIMEOUT_MS = 60000;

    // المعامل الصحيح هو account.publickey وليس publickey
    const queryByKey = async (key) => {
        for (const base of MIRRORS) {
            try {
                const r = await axios.get(
                    `${base}/api/v1/accounts?account.publickey=${key}&limit=25`,
                    { timeout: TIMEOUT_MS }
                );
                const accounts      = r.data?.accounts || [];
                const totalTinybars = accounts.reduce((s, a) => s + (a.balance?.balance || 0), 0);
                const accountIds    = accounts.map(a => a.account).filter(Boolean);
                return { balance: totalTinybars / 1e8, txCount: accountIds.length, accountIds };
            } catch { continue; }
        }
        return null;
    };

    // محاولة Ed25519 (raw 32-byte hex = 64 chars)
    const ed25519Result = await queryByKey(pubhex);
    if (ed25519Result) return ed25519Result;

    // محاولة secp256k1 إن كان المفتاح مخزناً أيضاً (يُمرَّر كـ secpHex في pubhex2)
    return { balance: 0, txCount: 0, accountIds: [] };
}

// ── RPC: FIL native — Filecoin.WalletBalance (عدة مصادر) ──
async function rpcFIL(addr) {
    const parse = (r) => {
        const attoFIL = r.data.result || '0';
        return { balance: Number(BigInt(attoFIL)) / 1e18, txCount: 0 };
    };
    return raceSuccess([
        axios.post('https://api.node.glif.io/rpc/v0', {
            jsonrpc: '2.0', method: 'Filecoin.WalletBalance', params: [addr], id: 1,
        }, { timeout: 60000 }).then(parse).catch(() => null),
        axios.post('https://filecoin.public-rpc.com', {
            jsonrpc: '2.0', method: 'Filecoin.WalletBalance', params: [addr], id: 1,
        }, { timeout: 60000 }).then(parse).catch(() => null),
        axios.post('https://rpc.ankr.com/filecoin', {
            jsonrpc: '2.0', method: 'Filecoin.WalletBalance', params: [addr], id: 1,
        }, { timeout: 60000 }).then(parse).catch(() => null),
    ]);
}

// ── RPC: ATOM (Cosmos REST — race) ──
// cosmos.directory محجوب (HTTP 404 + 400) — تمت الإزالة
async function rpcATOM(addr) {
    const parse = (r) => {
        const uatom = r.data.balances?.find(b => b.denom === 'uatom')?.amount || '0';
        return { balance: Number(uatom) / 1e6, txCount: 0 };
    };
    return raceSuccess([
        axios.get(`https://cosmos-rest.publicnode.com/cosmos/bank/v1beta1/balances/${addr}`, { timeout: 60000 })
            .then(parse).catch(() => null),
        axios.get(`https://cosmos-api.polkachu.com/cosmos/bank/v1beta1/balances/${addr}`, { timeout: 60000 })
            .then(parse).catch(() => null),
    ]);
}

// ── RPC: XRP (XRPL HTTP — race) ──
// xrplcluster.com محجوب دائماً (FUP exceeded) — تم الاستبدال بـ xrpl.ws + s2.ripple
async function rpcXRP(addr) {
    const eps = ['https://xrpl.ws', 'https://s2.ripple.com:51234', 'https://s1.ripple.com:51234'];
    const tryOne = (ep) =>
        axios.post(ep, {
            method: 'account_info',
            params: [{ account: addr, ledger_index: 'current' }],
        }, { timeout: 60000 }).then(r => {
            if (r.data.result?.error === 'actNotFound') return { balance: 0, txCount: 0 };
            const drops = r.data.result?.account_data?.Balance || '0';
            const seq   = r.data.result?.account_data?.Sequence || 0;
            return { balance: Number(drops) / 1e6, txCount: seq };
        });
    return raceSuccess(eps.map(ep => tryOne(ep).catch(() => null)));
}

// ── RPC: VET (VeChain REST — race) ──
async function rpcVET(addr) {
    const eps = ['https://mainnet.vechain.org', 'https://vethor-node.vechain.com'];
    const tryOne = (ep) =>
        axios.get(`${ep}/accounts/${addr}`, { timeout: 60000 }).then(r => {
            const vet = r.data?.balance || '0x0';
            return { balance: Number(BigInt(vet)) / 1e18, txCount: 0 };
        });
    return raceSuccess(eps.map(ep => tryOne(ep).catch(() => null)));
}

// ── RPC: APT (Aptos REST API) ──
async function rpcAPT(addr) {
    const eps = [
        'https://fullnode.mainnet.aptoslabs.com',
    ];
    const tryOne = (ep) =>
        axios.get(
            `${ep}/v1/accounts/${addr}/resource/0x1::coin::CoinStore%3C0x1::aptos_coin::AptosCoin%3E`,
            { timeout: 60000 }
        ).then(r => ({ balance: Number(r.data?.data?.coin?.value || 0) / 1e8, txCount: 0 }));
    const result = await raceSuccess(eps.map(ep => tryOne(ep).catch(() => null)));
    return result ?? { balance: 0, txCount: 0 };
}

// ── RPC: Cosmos عام — publicnode/custom (cosmos.directory محجوب — تمت الإزالة) ──
async function rpcCosmosGeneric(addr, chainName, denom, decimals = 6, customEps = null) {
    const parse = (r) => {
        const coin = r.data.balances?.find(b => b.denom === denom)?.amount || '0';
        return { balance: Number(coin) / Math.pow(10, decimals), txCount: 0 };
    };
    const freeEps = customEps || [`https://${chainName}-rest.publicnode.com`];
    const freePrms = freeEps.map(ep =>
        axios.get(`${ep}/cosmos/bank/v1beta1/balances/${addr}`, { timeout: 60000 }).then(parse).catch(() => null)
    );
    return raceSuccess(freePrms);
}

// ── RPC: Terra Classic (LUNC) ──
// cosmos.directory محجوب — استُبدل بـ publicnode + terra.luncblaze
async function rpcLUNC(addr) {
    const parse = (r) => {
        const uluna = r.data.balances?.find(b => b.denom === 'uluna')?.amount || '0';
        return { balance: Number(uluna) / 1e6, txCount: 0 };
    };
    return raceSuccess([
        axios.get(`https://terra-classic-lcd.publicnode.com/cosmos/bank/v1beta1/balances/${addr}`, { timeout: 60000 })
            .then(parse).catch(() => null),
    ]);
}

// ── RPC: Substrate عام (Polkadot-like state_getStorage) ──
async function rpcSubstrate(pubhex, endpoints, decimals = 10) {
    const { blake2b } = require('@noble/hashes/blake2');
    const SYS_KEY = '26aa394eea5630e07c48ae0c9558cef7';
    const ACC_KEY = 'b99d880ec681799c0cf30e8886371da9';
    const pub     = Buffer.from(pubhex, 'hex');
    const b128    = Buffer.from(blake2b(pub, { dkLen: 16 })).toString('hex');
    const storKey = '0x' + SYS_KEY + ACC_KEY + b128 + pubhex;
    const parseResult = (r) => {
        const hex = r.data.result;
        if (!hex || hex === '0x' || hex === null) return { balance: 0, txCount: 0 };
        const buf = Buffer.from(hex.slice(2), 'hex');
        if (buf.length < 32) return { balance: 0, txCount: 0 };
        const freeLo = buf.readBigUInt64LE(16);
        const freeHi = buf.readBigUInt64LE(24);
        const free   = freeLo + freeHi * (2n ** 64n);
        return { balance: Number(free) / Math.pow(10, decimals), txCount: 0 };
    };
    const tryOne = (ep) =>
        axios.post(ep, { jsonrpc: '2.0', id: 1, method: 'state_getStorage', params: [storKey] },
            { timeout: 60000 }).then(parseResult);
    const result = await raceSuccess(endpoints.map(ep => tryOne(ep).catch(() => null)));
    return result;
}

// ── RPC: ICX (ICON JSON-RPC v3) ──
async function rpcICX(addr) {
    const body = { jsonrpc: '2.0', id: 1, method: 'icx_getBalance', params: { address: addr } };
    const parse = r => {
        if (r.data.error) return { balance: 0, txCount: 0 };
        const raw = BigInt(r.data.result || '0x0');
        return { balance: Number(raw) / 1e18, txCount: raw > 0n ? 1 : 0 };
    };
    return raceSuccess([
        axios.post('https://api.icon.community/api/v3', body, { timeout: 60000 }).then(parse).catch(() => null),
        axios.post('https://ctz.solidwallet.io/api/v3',  body, { timeout: 60000 }).then(parse).catch(() => null),
    ]);
}

// ── RPC: XNO (Nano — somenano proxy) ──
async function rpcXNO(addr) {
    const body = { action: 'account_balance', account: addr };
    return raceSuccess([
        axios.post('https://node.somenano.com/proxy', body, { timeout: 60000 })
            .then(r => {
                if (r.data.error) return { balance: 0, txCount: 0 };
                const raw = BigInt(r.data.balance || '0');
                return { balance: Number(raw) / 1e30, txCount: raw > 0n ? 1 : 0 };
            }).catch(e => (e.response?.status === 404 ? { balance: 0, txCount: 0 } : null)),
    ]);
}

// ── RPC: NEO3 (Neo N3 — nspcc.ru) ──
async function rpcNEO3(addr) {
    const NEO_HASH = '0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5';
    const body = { jsonrpc: '2.0', id: 1, method: 'getnep17balances', params: [addr] };
    const parse = (r) => {
        const items = r.data.result?.balance || [];
        const neo   = items.find(t => t.assethash === NEO_HASH);
        const amt   = Number(neo?.amount || 0);
        // lastupdatedblock=0 يعني المحفظة لم تُستخدم قط — الـ API تُعيد GAS وهمي لكل عنوان
        const hasActivity = items.some(t => Number(t.lastupdatedblock || 0) > 0);
        return { balance: amt, txCount: hasActivity ? 1 : 0 };
    };
    return raceSuccess([
        axios.post('https://rpc10.n3.nspcc.ru:10331',  body, { timeout: 60000 }).then(parse).catch(() => null),
        axios.post('https://mainnet1.neo.coz.io:443',   body, { timeout: 60000 }).then(parse).catch(() => null),
        axios.post('https://n3seed1.ngd.network:10332', body, { timeout: 60000 }).then(parse).catch(() => null),
    ]);
}

// ── RPC: CKB (Nervos — get_cells_capacity via indexer) ──
async function rpcCKB(args) {
    const lockScript = {
        code_hash: '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8',
        hash_type:  'type',
        args
    };
    const body = { jsonrpc: '2.0', id: 1, method: 'get_cells_capacity',
        params: [{ script: lockScript, script_type: 'lock' }] };
    return raceSuccess([
        axios.post('https://mainnet.ckbapp.dev/', body, { timeout: 60000 })
            .then(r => {
                const shannons = BigInt(r.data.result?.capacity || '0x0');
                return { balance: Number(shannons) / 1e8, txCount: shannons > 0n ? 1 : 0 };
            }).catch(() => null),
    ]);
}

// ── RPC: ADA (Cardano — Koios REST) ──
async function rpcADA(addr) {
    return raceSuccess([
        axios.post('https://api.koios.rest/api/v1/address_info',
            { _addresses: [addr] },
            { timeout: 60000, headers: { 'Content-Type': 'application/json' } }
        ).then(r => {
            const d = Array.isArray(r.data) ? r.data[0] : null;
            if (!d) return { balance: 0, txCount: 0 };
            return { balance: Number(d.balance || 0) / 1e6, txCount: d.tx_count || 0 };
        }).catch(e => (e.response?.status === 404 ? { balance: 0, txCount: 0 } : null)),
    ]);
}

// ── فحص عنوان واحد عبر RPC المناسب ──
async function checkEntryRpc(entry, prices) {
    const symbol = entry.type.replace('-TAP', '');
    const price  = prices[symbol] || 0;

    // ── Cosmos chains + Substrate chains — محمّلة من chains.json ──
    const COSMOS_CHAINS    = CHAINS.cosmos.chains;
    const SUBSTRATE_CHAINS = CHAINS.substrate.chains;

    // ── EVM RPC endpoints — محمّلة من chains.json ──
    const EVM_RPC = CHAINS.evm_rpc;

    let res = null;
    if      (entry.type === 'BTC' || entry.type === 'BTC-TAP') res = await rpcBTC(entry.addr);
    else if (entry.type === 'LTC')   res = await rpcBlockcypher(entry.addr, 'ltc');
    else if (entry.type === 'DOGE')  res = await rpcBlockcypher(entry.addr, 'doge');
    else if (entry.type === 'DASH')  res = await rpcBlockcypher(entry.addr, 'dash');
    else if (entry.type === 'BCH')   res = await rpcBlockcypher(entry.addr, 'bch');
    else if (entry.type === 'ZEC')   res = await rpcZEC(entry.addr);
    else if (entry.type === 'XLM')   res = await rpcXLM(entry.addr);
    else if (entry.type === 'ALGO')  res = await rpcALGO(entry.addr);
    else if (entry.type === 'NEAR')  res = await rpcNEAR(entry.addr);
    else if (entry.type === 'EGLD')  res = await rpcEGLD(entry.addr);
    else if (entry.type === 'HBAR') {
        res = await rpcHBAR(entry.pubhex || entry.addr);
        // تحديث العنوان بالحسابات الحقيقية المكتشفة من الشبكة
        if (res?.accountIds?.length > 0)
            entry.addr = res.accountIds.join(', ');
    }
    else if (entry.type === 'FIL')   res = await rpcFIL(entry.addr);
    else if (entry.type === 'TRX')   res = await rpcTRX(entry.addr);
    else if (entry.type === 'SUI')   res = await rpcSUI(entry.addr);
    else if (entry.type === 'ATOM')  res = await rpcATOM(entry.addr);
    else if (entry.type === 'XRP')   res = await rpcXRP(entry.addr);
    else if (entry.type === 'DOT')   res = await rpcDOT(entry.pubhex, false);
    else if (entry.type === 'KSM')   res = await rpcDOT(entry.pubhex, true);
    else if (entry.type === 'LUNC')  res = await rpcLUNC(entry.addr);
    else if (entry.type === 'VET')   res = await rpcVET(entry.addr);
    else if (entry.type === 'APT')   res = await rpcAPT(entry.addr);
    else if (COSMOS_CHAINS[entry.type]) {
        const cfg = COSMOS_CHAINS[entry.type];
        if (cfg.disabled) return { balance: 0, usd: 0, hasActivity: false, failed: false };
        res = await rpcCosmosGeneric(entry.addr, cfg.chain, cfg.denom, cfg.dec, cfg.eps || null);
    }
    else if (SUBSTRATE_CHAINS[entry.type]) {
        const { eps, dec } = SUBSTRATE_CHAINS[entry.type];
        res = await rpcSubstrate(entry.pubhex, eps, dec);
    }
    else if (entry.type === 'ECLIPSE')   res = await rpcSOL(entry.addr, ['https://mainnetbeta-rpc.eclipse.xyz']);
    else if (entry.type === 'SONIC_SVM') res = await rpcSOL(entry.addr, ['https://api.mainnet-alpha.sonic.game', 'https://sonic.helius-rpc.com']);
    else if (entry.type === 'SOON')      res = await rpcSOL(entry.addr, ['https://rpc.mainnet.soo.network/rpc']);
    else if (entry.type === 'XTZ')       res = await rpcXTZ(entry.addr);
    else if (entry.type === 'WAVES')     res = await rpcWAVES(entry.addr);
    else if (entry.type === 'STX')       res = await rpcSTX(entry.addr);
    else if (entry.type === 'ZIL')       res = await rpcZIL(entry.addrHex || entry.addr);

    else if (entry.type === 'TON')       res = await rpcTON(entry.addr);
    else if (EVM_RPC[entry.type]) {
        const eps = EVM_RPC[entry.type];
        if (!Array.isArray(eps) || eps.length === 0)
            return { balance: 0, usd: 0, hasActivity: false, failed: false };
        res = await rpcEVM(entry.addr, eps, entry.type === 'VTRU');
    }
    else if (entry.type === 'ICX')   res = await rpcICX(entry.addr);
    else if (entry.type === 'XNO')   res = await rpcXNO(entry.addr);
    else if (entry.type === 'NEO')   res = await rpcNEO3(entry.addr);
    else if (entry.type === 'CKB')   res = await rpcCKB(entry.ckbArgs || entry.addr);
    else if (entry.type === 'ADA')   res = await rpcADA(entry.addr);

    if (!res) return { balance: 0, usd: 0, hasActivity: false, failed: true };
    const usd = res.balance * price;
    return { balance: res.balance, usd, hasActivity: res.txCount > 0 || res.balance > 0, failed: false };
}

async function runRpcSeedScan() {
    const OUTPUT_FILE = require('path').join(__dirname, 'results_rpc_seeds.txt');
    const out = (line) => { console.log(line); fs.appendFileSync(OUTPUT_FILE, line + '\n', 'utf-8'); };

    fs.appendFileSync(OUTPUT_FILE, `\n=== فحص العبارات RPC — ${new Date().toLocaleString()} ===\n\n`, 'utf-8');
    console.log(`\n📋 أمر 11 — اشتقاق العناوين + فحص RPC مباشر (بدون OKX)`);
    console.log(`   ──── شبكات غير EVM (سريعة — بدون rate-limit) ────`);
    console.log(`   LTC·BCH·TRX·SUI·XRP·DOT·KSM·XLM·ALGO·HBAR·FIL`);
    console.log(`   ATOM·OSMO·SEI·TIA·AKT·JUNO·KAVA·INJ + LUNC·VET·APT`);
    console.log(`   + Cosmos: NTRN·DYDX·AXL·DVPN·HUAHUA·CHEQD·MNTL · Substrate: ASTR·ACA·CFG`);
    console.log(`   + SVM: ECLIPSE·SONIC_SVM·SOON · جديدة: ICX·XNO·NEO·CKB`);
    console.log(`   ⏸️  مُوقَّف مؤقتاً: DOGE·ZEC·EVMOS·CMDX`);
    console.log(`   ➡️  نُقل إلى أمر 14: BTC·BTC-TAP·DASH·NEAR·EGLD·STX·ETN·ZKFAIR·ADA + STARS·SCRT·STRD·BAND·UMEE·REGEN·IRIS·FETCH·XPRT·CRE·ROWAN·BCNA·NIBI·KUJI·LUNA·ARCH·ZKLINK`);
    console.log(`   ──── شبكات EVM — أمر 6 غائبة (RPC مباشر) ────`);
    console.log(`   OKT·HMY·IOTX·FRAX·ZETA·SONIC·VIC·EWT·EMERALD·FUSE·DFK·WAN`);
    console.log(`   DEGEN·CYBER·SYS·SAPPHIRE·NEON·PLATON·FIL_EVM`);
    console.log(`   + جديدة: CANTO·TLOS·DYM·SAGA·ESC·OMAX·MORPH·UNI_EVM·ZRC·SONEIUM·HEMI\n`);

    const { validateMnemonic } = require('@scure/bip39');
    const { wordlist }         = require('@scure/bip39/wordlists/english');

    if (!fs.existsSync(KEYS_FILE)) {
        console.log(`❌ الملف غير موجود: ${KEYS_FILE}`);
        return;
    }
    const rawLines = fs.readFileSync(KEYS_FILE, 'utf-8')
        .split('\n').map(l => l.trim()).filter(l => l.length > 0);

    // استخراج العبارة من كل سطر — يتجاهل النصوص الزائدة بعد الكلمات الـ12 أو 24
    const _limit11 = process.env.SCAN_LIMIT ? parseInt(process.env.SCAN_LIMIT) : Infinity;
    const mnemonics = rawLines
        .map(line => extractMnemonicWords(line))
        .filter(mn => mn !== null && validateMnemonic(mn, wordlist))
        .slice(0, _limit11);

    console.log(`📂 العبارات: ${mnemonics.length} من أصل ${rawLines.length} سطر`);
    if (!mnemonics.length) { console.log('❌ لا توجد عبارات صالحة'); return; }

    // ── جلب الأسعار والتحقق من العبارات بالتوازي ──
    process.stdout.write('💱 جلب الأسعار... ');
    const prices = await fetchAllRpcPrices();
    const pFmt = (v, d) => v ? v.toFixed(d) : 'N/A';
    console.log(
        `BTC $${pFmt(prices.BTC, 0)} · DOT $${pFmt(prices.DOT, 2)} · ` +
        `XRP $${pFmt(prices.XRP, 4)} · TRX $${pFmt(prices.TRX, 4)} · ` +
        `VET $${pFmt(prices.VET, 4)} · APT $${pFmt(prices.APT, 2)}`
    );

    console.log(`\n💰 فحص ${mnemonics.length} عبارة — اشتقاق + فحص لكل عبارة أثناء المعالجة...\n`);

    // سجل للملخص النهائي المرتّب
    const foundWallets = [];
    const CONCURRENCY  = os.cpus().length; // عدد العبارات التي تُفحص بالتوازي (= عدد الأنوية)
    let   nextIdx      = 0;

    const worker = async () => {
        while (true) {
            const mi = nextIdx++;
            if (mi >= mnemonics.length) break;

            const mnemonic = mnemonics[mi];
            if (!validateMnemonic(mnemonic, wordlist)) {
                console.log(`  ⚠️  عبارة غير صالحة (${mi + 1}): تخطي`);
                continue;
            }
            let entries;
            try {
                entries = deriveAddressesExtended(mnemonic);
            } catch (e) {
                const preview = mnemonic.split(' ').slice(0, 3).join(' ');
                console.log(`  ⚠️  فشل الاشتقاق: ${preview}... (${e.message})`);
                continue;
            }

            console.log(`\n🔍 [${mi + 1}/${mnemonics.length}] جارٍ الفحص...`);
            const t0 = Date.now();

            const results = await Promise.all(
                entries
                    .filter(e => !CMD14_CHAINS.has(e.type))
                    .map(entry => checkEntryRpc(entry, prices).then(r => ({ entry, r })))
            );
            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

            const walletHits   = [];
            const activityHits = [];
            const failedChains = [];

            for (const { entry, r } of results) {
                if (r.failed) {
                    failedChains.push(entry.type);
                } else if (r.usd > 0.01) {
                    console.log(`   [${entry.type}/${entry.index}] ${entry.addr.slice(0, 30)}…  ✅  $${r.usd.toFixed(2)}`);
                    walletHits.push({ ...entry, balance: r.balance, usd: r.usd });
                } else if (r.hasActivity) {
                    console.log(`   [${entry.type}/${entry.index}] ${entry.addr.slice(0, 30)}…  ✴️ `);
                    activityHits.push(entry);
                }
            }

            // ── تسجيل فوري إذا فشلت شبكات ──
            if (failedChains.length > 0) {
                const preview = mnemonic.split(' ').slice(0, 4).join(' ');
                logError(`[أمر 11] عبارة غير مكتملة | فشل ${failedChains.length} شبكة: ${failedChains.join('·')} | "${preview}..."`);
                logError(`[أمر 11] العبارة الكاملة: ${mnemonic}`);
            }

            console.log(`   ⏱  ${elapsed}s${failedChains.length ? `  ⚠️ فشل: ${failedChains.length} شبكة` : ''}`);

            // ── كتابة فورية لنتائج هذه العبارة ──
            if (walletHits.length > 0 || activityHits.length > 0) {
                const grand = walletHits.reduce((s, e) => s + e.usd, 0);
                foundWallets.push({ mnemonic, hits: walletHits, activityHits, grand });

                if (walletHits.length > 0) {
                    walletHits.sort((a, b) => b.usd - a.usd);
                    out('═'.repeat(60));
                    out(`✅ [${mi + 1}/${mnemonics.length}] عبارة بها رصيد`);
                    out(`🔑 ${mnemonic}`);
                    out(`   💰 الإجمالي: $${grand.toFixed(2)}`);
                    for (const h of walletHits) {
                        const priceSym = h.type.replace('-TAP', '');
                        const price    = prices[priceSym] || 0;
                        const priceStr = price < 1 ? price.toFixed(6) : price.toFixed(2);
                        out(`\n   [${h.label}/${h.index}] ${h.addr}`);
                        out(`   ${h.type}: ${fmt(h.balance)}  @$${priceStr}  ≈ $${h.usd.toFixed(2)}`);
                    }
                    out('');
                }

                if (activityHits.length > 0) {
                    out(`✴️  [${mi + 1}/${mnemonics.length}] عناوين نشطة (رصيد صفري):`);
                    out(`🔑 ${mnemonic}`);
                    for (const h of activityHits)
                        out(`   ✴️  [${h.type}/${h.index}] ${h.addr}`);
                    out('');
                }
            }

            // نقل العبارة إلى End.txt فور انتهاء فحصها
            moveToEnd(mnemonic);
        }
    };

    // تشغيل CONCURRENCY عمال بالتوازي
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const withBalance = foundWallets.filter(w => w.hits.length > 0);
    const activityCount = foundWallets.reduce((s, w) => s + w.activityHits.length, 0);
    console.log(`\n✅ انتهى | رصيد: ${withBalance.length} | ✴️ نشطة: ${activityCount}`);
    console.log(`📄 النتائج: ${OUTPUT_FILE}`);
}

// ─────────────────────────────────────────────
//  COMMAND 14 — BTC + Cosmos ثقيل (مُسلسَل لتجنب rate-limit)
// ─────────────────────────────────────────────
async function runRpcThrottledScan() {
    const OUTPUT_FILE = require('path').join(__dirname, 'results_rpc_seeds_14.txt');
    const out = (line) => { console.log(line); fs.appendFileSync(OUTPUT_FILE, line + '\n', 'utf-8'); };

    fs.appendFileSync(OUTPUT_FILE, `\n=== فحص شبكات الأمر 14 — ${new Date().toLocaleString()} ===\n\n`, 'utf-8');
    console.log(`\n📋 أمر 14 — شبكات محدودة السرعة (مُسلسَلة لتجنب rate-limit)`);
    console.log(`   ⚡ BTC · BTC-TAP   → blockstream + mempool (250ms)`);
    console.log(`   🟦 DASH            → blockcypher + cryptoid (380ms)`);
    console.log(`   🟩 NEAR · EGLD · STX · ETN · ZKFAIR · SIX · WATER`);
    console.log(`   🌌 Cosmos (polkachu): STARS·SCRT·STRD·BAND·UMEE·REGEN·IRIS`);
    console.log(`      FETCH·XPRT·CRE·ROWAN·BCNA·NIBI·KUJI·LUNA·ARCH`);
    console.log(`   🃏 ADA (Cardano)   → Koios REST API\n`);

    const { validateMnemonic } = require('@scure/bip39');
    const { wordlist }         = require('@scure/bip39/wordlists/english');

    if (!fs.existsSync(KEYS_FILE)) { console.log(`❌ الملف غير موجود: ${KEYS_FILE}`); return; }
    const rawLines = fs.readFileSync(KEYS_FILE, 'utf-8')
        .split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const mnemonics = rawLines
        .map(line => extractMnemonicWords(line))
        .filter(mn => mn !== null && validateMnemonic(mn, wordlist));

    console.log(`📂 العبارات: ${mnemonics.length} من أصل ${rawLines.length} سطر`);
    if (!mnemonics.length) { console.log('❌ لا توجد عبارات صالحة'); return; }

    process.stdout.write('💱 جلب الأسعار... ');
    const prices = await fetchAllRpcPrices();
    console.log(`BTC $${prices.BTC.toFixed(0)} · DASH $${(prices.DASH||0).toFixed(2)} · SCRT $${(prices.SCRT||0).toFixed(4)} · LUNA $${(prices.LUNA||0).toFixed(4)} · KUJI $${(prices.KUJI||0).toFixed(4)}`);

    console.log(`\n⏳ فحص ${mnemonics.length} عبارة — مُسلسَل لتفادي rate-limit...\n`);

    const foundWallets = [];
    let nextIdx = 0;

    const worker = async () => {
        while (true) {
            const mi = nextIdx++;
            if (mi >= mnemonics.length) break;

            const mnemonic = mnemonics[mi];
            if (!validateMnemonic(mnemonic, wordlist)) continue;

            let entries;
            try {
                entries = deriveAddressesExtended(mnemonic);
            } catch (e) {
                console.log(`  ⚠️  فشل الاشتقاق: ${mnemonic.split(' ').slice(0, 3).join(' ')}... (${e.message})`);
                continue;
            }

            const filtered = entries.filter(e => CMD14_CHAINS.has(e.type));
            if (!filtered.length) continue;

            console.log(`\n🔍 [${mi + 1}/${mnemonics.length}] جارٍ الفحص...`);
            const t0 = Date.now();

            const results = await Promise.all(
                filtered.map(entry => checkEntryRpc(entry, prices).then(r => ({ entry, r })))
            );
            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

            const walletHits = [], activityHits = [], failedChains = [];

            for (const { entry, r } of results) {
                if (r.failed) {
                    failedChains.push(entry.type);
                } else if (r.usd > 0.01) {
                    console.log(`   [${entry.type}/${entry.index}] ${entry.addr.slice(0, 30)}…  ✅  $${r.usd.toFixed(2)}`);
                    walletHits.push({ ...entry, balance: r.balance, usd: r.usd });
                } else if (r.hasActivity) {
                    console.log(`   [${entry.type}/${entry.index}] ${entry.addr.slice(0, 30)}…  ✴️ `);
                    activityHits.push(entry);
                }
            }

            if (failedChains.length > 0) {
                const preview = mnemonic.split(' ').slice(0, 4).join(' ');
                logError(`[أمر 14] فشل ${failedChains.length} شبكة: ${failedChains.join('·')} | "${preview}..."`);
                logError(`[أمر 14] العبارة الكاملة: ${mnemonic}`);
            }

            console.log(`   ⏱  ${elapsed}s${failedChains.length ? `  ⚠️ فشل: ${failedChains.length} شبكة` : ''}`);

            if (walletHits.length > 0 || activityHits.length > 0) {
                const grand = walletHits.reduce((s, e) => s + e.usd, 0);
                foundWallets.push({ mnemonic, hits: walletHits, activityHits, grand });

                if (walletHits.length > 0) {
                    walletHits.sort((a, b) => b.usd - a.usd);
                    out('═'.repeat(60));
                    out(`✅ [${mi + 1}/${mnemonics.length}] عبارة بها رصيد`);
                    out(`🔑 ${mnemonic}`);
                    out(`   💰 الإجمالي: $${grand.toFixed(2)}`);
                    for (const h of walletHits) {
                        const priceSym = h.type.replace('-TAP', '');
                        const price    = prices[priceSym] || 0;
                        const priceStr = price < 1 ? price.toFixed(6) : price.toFixed(2);
                        out(`\n   [${h.label}/${h.index}] ${h.addr}`);
                        out(`   ${h.type}: ${fmt(h.balance)}  @$${priceStr}  ≈ $${h.usd.toFixed(2)}`);
                    }
                    out('');
                }
                if (activityHits.length > 0) {
                    out(`✴️  [${mi + 1}/${mnemonics.length}] عناوين نشطة (رصيد صفري):`);
                    out(`🔑 ${mnemonic}`);
                    for (const h of activityHits)
                        out(`   ✴️  [${h.type}/${h.index}] ${h.addr}`);
                    out('');
                }
            }

            // نقل العبارة إلى End.txt فور انتهاء فحصها
            moveToEnd(mnemonic);
        }
    };

    await Promise.all(Array.from({ length: 1 }, worker));

    const withBalance = foundWallets.filter(w => w.hits.length > 0);
    const activityCount = foundWallets.reduce((s, w) => s + w.activityHits.length, 0);
    console.log(`\n✅ انتهى | رصيد: ${withBalance.length} | ✴️ نشطة: ${activityCount}`);
    console.log(`📄 النتائج: results_rpc_seeds_14.txt`);
}

// ─────────────────────────────────────────────
//  COMMAND 12 — فحص عناوين EVM من addresses.txt عبر RPC
// ─────────────────────────────────────────────
async function runRpcEvmScan(balanceOnly = false) {
    const OUTPUT_FILE = require('path').join(__dirname, balanceOnly ? 'results_rpc_evm_fast.txt' : 'results_rpc_evm.txt');
    const out = (line) => { console.log(line); fs.appendFileSync(OUTPUT_FILE, line + '\n', 'utf-8'); };

    // ── جلب الأسعار فوراً في الخلفية قبل أي شيء آخر ──
    process.stdout.write('💱 جلب الأسعار... ');
    const pricesPromise = fetchAllRpcPrices();

    fs.appendFileSync(OUTPUT_FILE, `\n=== فحص EVM عبر RPC ${balanceOnly ? '(رصيد فقط)' : ''} — ${new Date().toLocaleString()} ===\n\n`, 'utf-8');
    console.log(`\n📋 ${balanceOnly ? 'أمر 17 — فحص EVM سريع (رصيد فقط — بدون نشاط)' : 'أمر 12 — فحص عناوين EVM عبر RPC'}`);

    const all  = readAddresses();
    if (!all.length) { console.log('❌ لا توجد عناوين في الملف'); return; }

    const evms = all.filter(a => /^0x[0-9a-fA-F]{40}$/.test(a));
    if (!evms.length) { console.log('❌ لا توجد عناوين EVM (0x...) في الملف'); return; }
    console.log(`📂 عناوين EVM: ${evms.length}/${all.length}\n`);

    // شبكات EVM غير موجودة في الأمر 6 (الأمر 6 يغطي الشبكات الرئيسية عبر OKX)
    const EVM_CHAINS = [
        { symbol: 'OKT',      name: 'OKC',            eps: ['https://oktc.drpc.org', 'https://exchainrpc.okex.org'] },
        { symbol: 'HMY',      name: 'Harmony',        eps: ['https://a.api.s0.t.hmny.io',            'https://api.harmony.one'] },
        { symbol: 'IOTX',     name: 'IoTeX',          eps: ['https://babel-api.mainnet.iotex.io'] },
        { symbol: 'ZETA',     name: 'ZetaChain',      eps: ['https://zeta-chain.drpc.org', 'https://zetachain-evm.blockpi.network/v1/rpc/public', 'https://zetachain-mainnet.g.allthatnode.com/archive/evm'] },
        { symbol: 'SONIC',    name: 'Sonic',          eps: ['https://sonic-rpc.publicnode.com',      'https://rpc.soniclabs.com'] },
        { symbol: 'VIC',      name: 'Viction',        eps: ['https://rpc.viction.xyz',               'https://viction.blockpi.network/v1/rpc/public'] },
        { symbol: 'EWT',      name: 'EnergyWeb',      eps: ['https://rpc.energyweb.org',             'https://energyweb.rpc.thirdweb.com'] },
        { symbol: 'EMERALD',  name: 'Oasis Emerald',  eps: ['https://emerald.oasis.dev', 'https://emerald.oasis.io', 'https://oasis-emerald-mainnet.rpc.thirdweb.com'] },
        { symbol: 'FUSE',     name: 'Fuse',           eps: ['https://rpc.fuse.io',                   'https://fuse-mainnet.rpc.thirdweb.com'] },
        { symbol: 'DFK',      name: 'DFK Chain',      eps: ['https://subnets.avax.network/defi-kingdoms/dfk-chain/rpc'] },
        { symbol: 'WAN',      name: 'Wanchain',       eps: ['https://gwan-ssl.wandevs.org:46891/',   'https://gwan-ssl.wandevs.org:56891'] },
        { symbol: 'ZKFAIR',   name: 'ZKFair',         eps: ['https://rpc.zkfair.io'] },
        { symbol: 'DEGEN',    name: 'Degen',          eps: ['https://rpc.degen.tips',                'https://degen-mainnet.public.blastapi.io'] },
        { symbol: 'CYBER',    name: 'Cyber',          eps: ['https://rpc.cyber.co/',                 'https://cyber.alt.technology'] },
        { symbol: 'SYS',      name: 'Syscoin',        eps: ['https://syscoin-evm.publicnode.com',    'https://rpc.syscoin.org'] },
        { symbol: 'SAPPHIRE', name: 'Oasis Sapphire', eps: ['https://sapphire.oasis.io',             'https://oasis-sapphire-mainnet.rpc.thirdweb.com'] },
        { symbol: 'NEON',     name: 'Neon EVM',       eps: ['https://neon-mainnet.everstake.one', 'https://neon-evm.drpc.org', 'https://neon-proxy-mainnet.solana.p2p.org'] },
        { symbol: 'FIL_EVM',  name: 'Filecoin EVM',   eps: ['https://api.node.glif.io/rpc/v1',              'https://rpc.ankr.com/filecoin'] },
        { symbol: 'FRAX',     name: 'Fraxtal',         eps: ['https://fraxtal.drpc.org', 'https://fraxtal-rpc.publicnode.com', 'https://rpc.frax.com'] },
        { symbol: 'PLATON',   name: 'PlatON',          eps: ['https://openapi2.platon.network/rpc',          'https://openapi.platon.network/rpc'] },
        // ── شبكات مضافة من rpc.txt (مُختبرة ✅) ──
        { symbol: 'XPLA',     name: 'XPLA',            eps: ['https://dimension-evm-rpc.xpla.dev'] },
        { symbol: 'ONT',      name: 'Ontology',        eps: ['https://dappnode1.ont.io:10339'] },
        { symbol: 'LYX',      name: 'LUKSO',           eps: ['https://rpc.mainnet.lukso.network'] },
        { symbol: 'SGB',      name: 'Songbird',        eps: ['https://songbird-api.flare.network/ext/C/rpc'] },
        { symbol: 'XDC',      name: 'XDC Network',     eps: ['https://erpc.xinfin.network', 'https://rpc.ankr.com/xdc', 'https://rpc1.xinfin.network'] },
        { symbol: 'META',     name: 'Metadium',        eps: ['https://api.metadium.com/prod'] },
        { symbol: 'GO',       name: 'GoChain',         eps: ['https://rpc.gochain.io'] },
        { symbol: 'RBTC',     name: 'Rootstock',       eps: ['https://public-node.rsk.co'] },
        // { symbol: 'CET',   name: 'CoinEx Smart Chain', eps: ['https://rpc.coinex.net'] },   // ⏸ موقوف مؤقتاً
        { symbol: 'RING',     name: 'Darwinia',        eps: ['https://rpc.darwinia.network'] },
        { symbol: 'KUB',      name: 'Bitkub Chain',    eps: ['https://rpc.bitkubchain.io'] },
        { symbol: 'MTR',      name: 'Meter',           eps: ['https://rpc.meter.io'], noNonce: true },
        { symbol: 'GT',       name: 'GateChain',       eps: ['https://evm.gatenode.cc'] },
        { symbol: 'VLX',      name: 'Velas EVM',       eps: ['https://explorer.velas.com/rpc', 'https://evmexplorer.velas.com/rpc'] },
        { symbol: 'RLC',      name: 'iExec Sidechain', eps: ['https://bellecour.iex.ec'] },
        { symbol: 'HSK',      name: 'HashKey Chain',   eps: ['https://mainnet.hsk.xyz'] },
        { symbol: 'SMR',      name: 'ShimmerEVM',      eps: ['https://json-rpc.evm.shimmer.network'] },
        { symbol: 'AIOZ',     name: 'AIOZ Network',    eps: ['https://eth-dataseed.aioz.network'] },
        { symbol: 'SIX',      name: 'Six Protocol',    eps: ['https://sixnet-rpc-evm.sixprotocol.net'] },
        { symbol: 'U2U',      name: 'U2U Solaris',     eps: ['https://rpc-mainnet.u2u.xyz'] },
        { symbol: 'UNI_EVM',  name: 'Unichain',        eps: ['https://unichain-rpc.publicnode.com', 'https://mainnet.unichain.org'] },
        { symbol: 'DEL',      name: 'Decimal Chain',   eps: ['https://node.decimalchain.com/web3/'] },
        // { symbol: 'EXP',   name: 'Expanse',            eps: ['https://node.expanse.tech'] },   // ⏸ موقوف مؤقتاً
        // ── شبكات DefiLlama + chainlist (مُختبرة ✅) ──
        { symbol: 'MEGA',     name: 'MegaETH',         eps: ['https://mainnet.megaeth.com/rpc'] },
        { symbol: 'PLUME',    name: 'Plume',           eps: ['https://rpc.plume.org'] },
        { symbol: 'WLD',      name: 'World Chain',     eps: ['https://worldchain-mainnet.g.alchemy.com/public'] },
        { symbol: 'IP',       name: 'Story',           eps: ['https://mainnet.storyrpc.io'] },
        { symbol: 'FLOW',     name: 'Flow EVM',        eps: ['https://mainnet.evm.nodes.onflow.org'] },
        { symbol: 'INK',      name: 'Ink',             eps: ['https://rpc-gel.inkonchain.com'] },
        { symbol: 'KAT',      name: 'Katana',          eps: ['https://rpc.katana.network'] },
        { symbol: 'SONEIUM',  name: 'Soneium',         eps: ['https://rpc.soneium.org'] },
        { symbol: 'BLEND',    name: 'Fluent',          eps: ['https://rpc.fluent.xyz'] },
        { symbol: 'HEMI',     name: 'Hemi',            eps: ['https://rpc.hemi.network/rpc'] },
        { symbol: 'BERA',     name: 'Berachain',       eps: ['https://berachain.drpc.org', 'https://rpc.berachain.com', 'https://berachain-mainnet.public.blastapi.io'] },
        { symbol: 'ZKCRO',    name: 'Cronos zkEVM',    eps: ['https://mainnet.zkevm.cronos.org'] },
        { symbol: 'ABS',      name: 'Abstract',        eps: ['https://api.mainnet.abs.xyz'] },
        { symbol: 'AIL',      name: 'AILayer',         eps: ['https://mainnet-rpc.ailayer.xyz'] },
        { symbol: 'TAC',      name: 'TAC',             eps: ['https://tac.drpc.org', 'https://rpc.ankr.com/tac', 'https://rpc.tac.build'] },
        { symbol: 'ZG',       name: '0G',              eps: ['https://evmrpc.0g.ai'] },
        { symbol: 'IOTA_EVM', name: 'IOTA EVM',        eps: ['https://rpc.ankr.com/iota_evm', 'https://json-rpc.evm.iotaledger.net'] },
        { symbol: 'LSK',      name: 'Lisk',            eps: ['https://lisk.drpc.org', 'https://rpc.api.lisk.com'] },
        { symbol: 'CHZ',      name: 'Chiliz',          eps: ['https://rpc.chiliz.com'] },
        { symbol: 'XTZ_EVM',  name: 'Etherlink',       eps: ['https://node.mainnet.etherlink.com'] },
        { symbol: 'NIBI_EVM', name: 'Nibiru EVM',      eps: ['https://evm-rpc.nibiru.fi'] },
        { symbol: 'BTC_BOT',  name: 'Botanix',         eps: ['https://rpc.botanixlabs.com'] },
        { symbol: 'BEAM',     name: 'Beam',            eps: ['https://subnets.avax.network/beam/mainnet/rpc', 'https://build.onbeam.com/rpc'] },
        { symbol: 'HELA',     name: 'HeLa',            eps: ['https://mainnet-rpc.helachain.com'] },
        { symbol: 'ZRC',      name: 'Zircuit',         eps: ['https://mainnet.zircuit.com'] },
        { symbol: 'THETA',    name: 'Theta',           eps: ['https://eth-rpc-api.thetatoken.org/rpc'] },
        { symbol: 'APE',      name: 'ApeChain',        eps: ['https://apechain.drpc.org', 'https://rpc.apechain.com'] },
        { symbol: 'TT',       name: 'ThunderCore',     eps: ['https://mainnet-rpc.thundercore.com'] },
        { symbol: 'GOAT',     name: 'Goat',            eps: ['https://rpc.goat.network'] },
        // { symbol: 'REYA',  name: 'Reya',            eps: ['https://rpc.reya.network'] },   // ⏸ كل الروابط معطوبة
        { symbol: 'BTT',      name: 'Bittorrent',      eps: ['https://bttc.trongrid.io', 'https://rpc.bt.io'] },
        { symbol: 'ZORA',     name: 'Zora',            eps: ['https://zora.drpc.org', 'https://rpc.zora.energy/'] },
        { symbol: 'ETH_SWELL',name: 'Swellchain',      eps: ['https://rpc.ankr.com/swell', 'https://swell.drpc.org', 'https://swell-mainnet.alt.technology'] },
        { symbol: 'PEAQ',     name: 'Peaq',            eps: ['https://peaq-rpc.publicnode.com', 'https://quicknode1.peaq.xyz'] },
        { symbol: 'NRG',      name: 'Energi',          eps: ['https://nodeapi.energi.network'] },
        { symbol: 'TAO_EVM',  name: 'Bittensor EVM',   eps: ['https://lite.chain.opentensor.ai'] },
        { symbol: 'SDN',      name: 'Shiden',          eps: ['https://evm.shiden.astar.network', 'https://shiden.api.onfinality.io/public'] },
        { symbol: 'SOPH',     name: 'Sophon',          eps: ['https://rpc.sophon.xyz'] },
        { symbol: 'ETN',      name: 'Electroneum',     eps: ['https://rpc.ankr.com/electroneum', 'https://rpc.electroneum.com'] },
        { symbol: 'XFI',      name: 'CrossFi',         eps: ['https://rpc.mainnet.ms/'] },
        { symbol: 'XRPL_EVM', name: 'XRPL EVM',        eps: ['https://rpc.xrplevm.org'] },
        // { symbol: 'RWA',   name: 'Asset Chain',     eps: ['https://mainnet-rpc.assetchain.org'] },   // ⏸ كل الروابط معطوبة
        { symbol: 'LENS',     name: 'Lens',            eps: ['https://lens.drpc.org', 'https://rpc.lens.xyz'] },
        // ── شبكات الأمر 11 و 14 (EVM) ──
        { symbol: 'ROLLUX',   name: 'Rollux',              eps: ['https://rpc.rollux.com'] },
        { symbol: 'VANA',     name: 'Vana',                eps: ['https://rpc.vana.org/'] },
        { symbol: 'ACA_EVM',  name: 'Acala-EVM',           eps: ['https://eth-rpc-acala.aca-api.network'] },
        { symbol: 'MEER',     name: 'Qitmeer',             eps: ['https://qng.rpc.qitmeer.io'] },
        { symbol: 'NERO',     name: 'Nerochain',           eps: ['https://rpc.nerochain.io'] },
        { symbol: 'TNET',     name: 'Tenet',               eps: ['https://rpc.tenet.org'] },
        { symbol: 'MAT',      name: 'MatChain',            eps: ['https://rpc.matchain.io'] },
        { symbol: 'ELY',      name: 'Elysium',             eps: ['https://rpc.elysiumchain.us', 'https://rpc.elysiumchain.tech'] },
        { symbol: 'AIA',      name: 'AIA-Chain',           eps: ['https://aia-dataseed1.aiachain.org', 'https://aia-dataseed2.aiachain.org'] },
        { symbol: 'VINU',     name: 'VinuChain',           eps: ['https://vinufoundation-rpc.com', 'https://vinuchain-rpc.com'] },
        { symbol: 'CAM',      name: 'Camino',              eps: ['https://api.camino.network/ext/bc/C/rpc'] },
        { symbol: 'GLQ',      name: 'GraphLinq',           eps: ['https://glq-dataseed.graphlinq.io'] },
        { symbol: 'GLUE',     name: 'Glue',                eps: ['https://rpc.glue.net'] },
        { symbol: 'THAI',     name: 'ThaiChain',           eps: ['https://rpc.thaichain.org', 'https://rpc.dome.cloud'] },
        { symbol: 'GL1',      name: 'GenesisL1',           eps: ['https://rpc.genesisl1.org'] },
        { symbol: 'ABEY',     name: 'AbeyChain',           eps: ['https://rpc.abeychain.com'] },
        { symbol: 'IDC',      name: 'IdChain',             eps: ['https://idchain.one/rpc/'] },
        { symbol: 'CO2',      name: 'CO2-Ledger',          eps: ['https://rpc.co2ledger.xyz'] },
        { symbol: 'LYC',      name: 'LycanChain',          eps: ['https://rpc.lycanchain.com/'] },
        { symbol: 'DSC',      name: 'DSC',                 eps: ['https://rpc01.dscscan.io'] },
        { symbol: 'MAAL',     name: 'MAAL-Chain',          eps: ['https://node1-mainnet.maalscan.io/', 'https://node2-mainnet.maalscan.io/'] },
        { symbol: 'EVOZ',     name: 'EvoZ',                eps: ['https://rpc.evozscan.com'] },
        { symbol: 'RBA',      name: 'Roburna',             eps: ['https://dataseed.roburna.com'] },
        { symbol: 'GZN',      name: 'GZN',                 eps: ['https://gzn.linksme.info'] },
        { symbol: 'EIOB',     name: 'EIOB',                eps: ['https://rpc.eiob.xyz'] },
        { symbol: 'AME',      name: 'AmeChain',            eps: ['https://node1.amechain.io/'] },
        { symbol: 'EVA',      name: 'EVA',                 eps: ['https://evascan.io/api/eth-rpc/'] },
        { symbol: 'XSC',      name: 'XSC',                 eps: ['https://datarpc1.xsc.pub', 'https://datarpc2.xsc.pub'] },
        { symbol: 'WATER',    name: 'Waterfall',           eps: ['https://rpc.waterfall.network/'] },
        { symbol: 'RAMA',     name: 'Ramestta',            eps: ['https://blockchain.ramestta.com', 'https://blockchain2.ramestta.com'] },
        { symbol: 'IOST',     name: 'IOST-EVM',            eps: ['https://iost-mainnet.alt.technology'] },
        { symbol: 'DILL',     name: 'Dill',                eps: ['https://rpc-alps.dill.xyz'] },
        { symbol: 'JUMBO',    name: 'JumboChain',          eps: ['https://rpc.jumbochain.org', 'https://testnode.jumbochain.org'] },
        { symbol: 'SEI_EVM',  name: 'Sei-EVM',             eps: ['https://evm-rpc.sei-apis.com', 'https://sei-evm-rpc.publicnode.com'] },
        { symbol: 'MEZO',     name: 'Mezo',                eps: ['https://mezo.drpc.org', 'https://mezo-mainnet.boar.network'] },
        { symbol: 'STABLE',   name: 'Stable',              eps: ['https://stable-mainnet.rpc.sentio.xyz', 'https://rpc.stable.xyz'] },
        { symbol: 'ENIAC',    name: 'Eniac',               eps: ['https://rpc.eniac.network', 'https://rpc2.eniac.network'] },
        { symbol: 'CANTO',    name: 'Canto',               eps: ['https://canto.gravitychain.io'] },
        { symbol: 'TLOS',     name: 'Telos EVM',           eps: ['https://telos.drpc.org', 'https://rpc.telos.net'] },
        { symbol: 'DYM',      name: 'Dymension',           eps: ['https://dymension.drpc.org', 'https://dymension.api.onfinality.io/public'] },
        { symbol: 'SAGA',     name: 'Saga',                eps: ['https://sagaevm.jsonrpc.sagarpc.io'] },
        { symbol: 'ESC',      name: 'Elastos Smart Chain', eps: ['https://api2.elastos.io/esc', 'https://api.elastos.io/esc'] },
        { symbol: 'OMAX',     name: 'Omax',                eps: ['https://mainapi.omaxray.com'] },
        { symbol: 'RON',      name: 'Ronin',               eps: ['https://ronin.drpc.org', 'https://api.roninchain.com/rpc'] },
        { symbol: 'BLAST',    name: 'Blast',               eps: ['https://rpc.blast.io', 'https://blast-rpc.publicnode.com'] },
        { symbol: 'SCROLL',   name: 'Scroll',              eps: ['https://1rpc.io/scroll', 'https://scroll-rpc.publicnode.com'] },
        { symbol: 'LINEA',    name: 'Linea',               eps: ['https://linea-rpc.publicnode.com', 'https://1rpc.io/linea'] },
        { symbol: 'MANTLE',   name: 'Mantle',              eps: ['https://rpc.mantle.xyz', 'https://mantle-rpc.publicnode.com', 'https://mantle.drpc.org'] },
        { symbol: 'TAIKO',    name: 'Taiko',               eps: ['https://rpc.taiko.xyz', 'https://taiko-rpc.publicnode.com'] },
        { symbol: 'MERLIN',   name: 'Merlin',              eps: ['https://rpc.merlinchain.io', 'https://merlin.drpc.org'] },
        { symbol: 'MANTA',    name: 'Manta Pacific',       eps: ['https://pacific-rpc.manta.network/http', 'https://manta-pacific.drpc.org'] },
        { symbol: 'XLAYER',   name: 'X Layer',             eps: ['https://rpc.xlayer.tech', 'https://xlayerrpc.okx.com'] },
        { symbol: 'IMX',      name: 'Immutable zkEVM',     eps: ['https://rpc.immutable.com'] },
        { symbol: 'WEMIX',    name: 'WEMIX',               eps: ['https://api.wemix.com', 'https://wemix.drpc.org'] },
        { symbol: 'KAIA',     name: 'Kaia',                eps: ['https://public-en.node.kaia.io', 'https://kaia.drpc.org'] },
        { symbol: 'CORE',     name: 'Core',                eps: ['https://rpc.coredao.org', 'https://rpc.ankr.com/core'] },
        { symbol: 'CFX',      name: 'Conflux eSpace',      eps: ['https://evm.confluxrpc.com', 'https://evm.confluxrpc.org'] },
        { symbol: 'BITLAYER', name: 'BitLayer',            eps: ['https://rpc.bitlayer-rpc.com', 'https://rpc.ankr.com/bitlayer'] },
        { symbol: 'MORPH',    name: 'Morph',               eps: ['https://rpc-quicknode.morphl2.io', 'https://morph.drpc.org'] },
        { symbol: 'GRAVITY',  name: 'Gravity',             eps: ['https://rpc.ankr.com/gravity', 'https://rpc.gravity.xyz'] },
        { symbol: 'ZKLINK',   name: 'zkLink Nova',         eps: ['https://rpc.zklink.network', 'https://rpc.zklink.io'] },
        { symbol: 'MONAD',    name: 'Monad',               eps: ['https://monad-mainnet.drpc.org'] },
        // { symbol: 'VTRU',  name: 'Vitruveo',            eps: ['https://rpc.vitruveo.xyz'], noSslVerify: true },   // ⏸ كل الروابط معطوبة
        { symbol: 'SCAI',     name: 'SCAI Network',        eps: ['https://mainnet-rpc.scai.network'] },
        // ── شبكات الأمر 6 (OKX) — مضافة عبر chainlist (مُختبرة ✅) ──
        { symbol: 'ETH',      name: 'Ethereum',            eps: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://ethereum.publicnode.com'] },
        { symbol: 'OP',       name: 'Optimism',            eps: ['https://optimism.drpc.org', 'https://optimism.publicnode.com', 'https://optimism-rpc.publicnode.com'] },
        { symbol: 'BNB',      name: 'BNB Chain',           eps: ['https://bsc.publicnode.com', 'https://bsc-rpc.publicnode.com', 'https://bsc-dataseed1.defibit.io'] },
        { symbol: 'GNO',      name: 'Gnosis',              eps: ['https://rpc.gnosis.gateway.fm', 'https://rpc.gnosischain.com', 'https://gnosis-rpc.publicnode.com'] },
        { symbol: 'POL',      name: 'Polygon',             eps: ['https://polygon.drpc.org', 'https://polygon-bor-rpc.publicnode.com', 'https://polygon.publicnode.com'] },
        { symbol: 'FTM',      name: 'Fantom',              eps: ['https://fantom.drpc.org', 'https://rpcapi.fantom.network'] },
        { symbol: 'ZKS',      name: 'zkSync Era',          eps: ['https://zksync.drpc.org', 'https://mainnet.era.zksync.io'] },
        { symbol: 'PZKEVM',   name: 'Polygon zkEVM',       eps: ['https://polygon-zkevm.drpc.org', 'https://zkevm-rpc.com'] },
        { symbol: 'GLMR',     name: 'Moonbeam',            eps: ['https://moonbeam.drpc.org', 'https://moonbeam.api.onfinality.io/public', 'https://moonbeam-rpc.publicnode.com'] },
        { symbol: 'BASE',     name: 'Base',                eps: ['https://base.drpc.org', 'https://base-rpc.publicnode.com', 'https://base.publicnode.com'] },
        { symbol: 'CRO',      name: 'Cronos',              eps: ['https://evm.cronos.org', 'https://cronos-evm-rpc.publicnode.com', 'https://cronos.drpc.org'] },
        { symbol: 'ARB',      name: 'Arbitrum One',        eps: ['https://arbitrum.drpc.org', 'https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'] },
        { symbol: 'CELO',     name: 'Celo',                eps: ['https://celo.drpc.org', 'https://forno.celo.org', 'https://celo.publicnode.com'] },
        { symbol: 'AVAX',     name: 'Avalanche',           eps: ['https://avalanche.drpc.org', 'https://avalanche-c-chain-rpc.publicnode.com', 'https://api.avax.network/ext/bc/C/rpc'] },
        { symbol: 'ETC',      name: 'Ethereum Classic',    eps: ['https://etc.drpc.org', 'https://etc.rivet.link', 'https://etc.etcdesktop.com'] },
        { symbol: 'FLR',      name: 'Flare',               eps: ['https://rpc.au.cc/flare', 'https://rpc.ankr.com/flare', 'https://flare-api.flare.network/ext/C/rpc'] },
        { symbol: 'KCS',      name: 'KCC',                 eps: ['https://rpc-mainnet.kcc.network'] },
        { symbol: 'METIS',    name: 'Metis',               eps: ['https://metis.drpc.org', 'https://metis-rpc.publicnode.com', 'https://andromeda.metis.io/?owner=1088'] },
        { symbol: 'BOBA',     name: 'Boba Network',        eps: ['https://boba-eth.drpc.org', 'https://boba-ethereum.gateway.tenderly.co', 'https://gateway.tenderly.co/public/boba-ethereum'] },
        { symbol: 'AURORA',   name: 'Aurora',              eps: ['https://aurora.drpc.org', 'https://mainnet.aurora.dev'] },
        { symbol: 'MOVR',     name: 'Moonriver',           eps: ['https://moonriver-rpc.publicnode.com', 'https://moonriver.drpc.org', 'https://moonriver.api.onfinality.io/public'] },
        { symbol: 'ARB_NOVA', name: 'Arbitrum Nova',       eps: ['https://arbitrum-nova.drpc.org', 'https://arbitrum-nova.publicnode.com', 'https://arbitrum-nova-rpc.publicnode.com'] },
        { symbol: 'ACE',      name: 'Endurance',           eps: ['https://rpc-endurance.fusionist.io/'] },
        { symbol: 'KAVA',     name: 'Kava',                eps: ['https://kava-evm-rpc.publicnode.com', 'https://rpc.ankr.com/kava_evm', 'https://kava.drpc.org'] },
        { symbol: 'PLS',      name: 'PulseChain',          eps: ['https://pulsechain-rpc.publicnode.com', 'https://pulsechain.publicnode.com', 'https://rpc.pulsechain.com'] },
        { symbol: 'OPBNB',    name: 'opBNB',               eps: ['https://opbnb-rpc.publicnode.com', 'https://opbnb-mainnet-rpc.bnbchain.org', 'https://opbnb.drpc.org'] },
        { symbol: 'ISLM',     name: 'Haqq',                eps: ['https://rpc.eth.haqq.network', 'https://haqq-evm.publicnode.com', 'https://haqq.drpc.org'] },
        { symbol: 'BOB',      name: 'BOB',                 eps: ['https://bob.drpc.org', 'https://rpc.gobob.xyz'] },
        { symbol: 'MODE',     name: 'Mode',                eps: ['https://mode.drpc.org', 'https://mainnet.mode.network'] },
        { symbol: 'B2',       name: 'B2 Network',          eps: ['https://mainnet.b2-rpc.com', 'https://rpc.ankr.com/b2', 'https://rpc.bsquared.network'] },
    ];

    // انتظر نتيجة الأسعار التي بدأت مسبقاً
    const prices = await pricesPromise;
    const pCount = Object.keys(prices).filter(k => prices[k] > 0).length;
    console.log(`✅ ${pCount} عملة — ETH $${(prices.ETH||0).toFixed(0)} · KAIA $${(prices.KAIA||0).toFixed(4)} · SONIC $${(prices.SONIC||0).toFixed(4)} · MANTLE $${(prices.MANTLE||0).toFixed(4)}`);

    const MIN_BALANCE = 1e-9; // حد أدنى للرصيد (للكشف عن أي رصيد)

    const foundAddrs   = [];
    const activeAddrs  = [];   // ✴️ نشطة بدون رصيد حالي
    let   totalSkipped = 0;    // CMD17: شبكات تجاوزت الـ timeout (بدون تسجيل خطأ)

    const END_FILE = require('path').join(__dirname, 'end_addr.txt');

    if (balanceOnly) {
        // ══════════════════════════════════════════════════════════
        //  أمر 17 — النهج السريع: batch JSON-RPC + chunks متوازية
        //  كل chunk يُرسل N عنوان في طلب واحد لكل شبكة بدل N طلب
        // ══════════════════════════════════════════════════════════
        const BATCH_SZ   = 20;   // عناوين في طلب JSON-RPC batch واحد
        const CHUNK_CONC = 4;    // chunks تُعالَج بالتوازي
        const TIMEOUT_17 = 10000; // ms لكل طلب RPC

        // ── semaphore للتحكم في التوازي ──
        const sem = (() => {
            let active = 0;
            const queue = [];
            return {
                acquire: () => new Promise(res => {
                    if (active < CHUNK_CONC) { active++; res(); }
                    else queue.push(res);
                }),
                release: () => {
                    if (queue.length) queue.shift()();
                    else active--;
                },
            };
        })();

        // ── تتبّع أخطاء الشبكات ──
        const chainFailCount  = {};   // sym → عدد مرات الفشل الكلي
        const chainErrSamples = {};   // sym → آخر رسالة خطأ

        // ── تقسيم العناوين إلى chunks ──
        const chunks = [];
        for (let i = 0; i < evms.length; i += BATCH_SZ)
            chunks.push(evms.slice(i, i + BATCH_SZ));

        console.log(`⚡ النهج السريع: batch=${BATCH_SZ} · concurrent=${CHUNK_CONC} · timeout=${TIMEOUT_17}ms`);
        console.log(`📦 ${chunks.length} مجموعة × ~${BATCH_SZ} عنوان\n`);

        // ── buffer مرتّب للطباعة (نضمن ترتيب الإخراج رغم التوازي) ──
        const printBuf  = new Map();   // chunk_idx → lines[]
        let   nextPrint = 0;
        const flushPrint = () => {
            while (printBuf.has(nextPrint)) {
                for (const line of printBuf.get(nextPrint)) process.stdout.write(line + '\n');
                printBuf.delete(nextPrint);
                nextPrint++;
            }
        };

        let doneAddrs = 0;

        await Promise.all(chunks.map(async (chunk, ci) => {
            await sem.acquire();
            try {
                const t0 = Date.now();

                // ── استعلام كل الشبكات بالتوازي لهذا الـ chunk ──
                const chainResponses = await Promise.all(EVM_CHAINS.map(async chain => {
                    const r = await rpcEVMBatch(chunk, chain.eps, chain.noSslVerify || false, TIMEOUT_17);
                    if (r.mode === 'failed') {
                        chainFailCount[chain.symbol]  = (chainFailCount[chain.symbol]  || 0) + chunk.length;
                        chainErrSamples[chain.symbol] = r.err;
                    }
                    return { chain, ...r };
                }));

                const chunkElapsed = ((Date.now() - t0) / 1000).toFixed(1);

                // ── جمع نتائج كل عنوان في الـ chunk ──
                const lines        = [];
                const activeLines  = [];   // سطور المحافظ النشطة فقط
                const chunkFailed  = new Set();   // رموز الشبكات الفاشلة على مستوى الـ chunk

                for (let ai = 0; ai < chunk.length; ai++) {
                    const addr = chunk[ai];
                    doneAddrs++;

                    const hits = [];

                    for (const cr of chainResponses) {
                        if (cr.mode === 'failed' || cr.balances[ai] === null) {
                            chunkFailed.add(cr.chain.symbol);
                            totalSkipped++;
                            continue;
                        }
                        const bal = cr.balances[ai];
                        if (bal >= MIN_BALANCE) {
                            const price = prices[cr.chain.symbol] || 0;
                            hits.push({ chain: cr.chain.name, symbol: cr.chain.symbol, balance: bal, usd: bal * price });
                        }
                    }

                    if (hits.length > 0) {
                        const total    = hits.reduce((s, h) => s + h.usd, 0);
                        const totalStr = total > 0.01 ? `$${total.toFixed(2)}` : (hits.some(h => !prices[h.symbol]) ? '$??' : '$0.00');
                        const priceTag = (h) => h.usd > 0.01 ? `  ≈ $${h.usd.toFixed(2)}` : (prices[h.symbol] ? '' : '  (لا سعر)');
                        activeLines.push(`   ✅ ${addr}   ${totalStr}  (${hits.length} شبكة)`);

                        // كتابة إلى ملف النتائج
                        fs.appendFileSync(OUTPUT_FILE, '─'.repeat(62) + '\n', 'utf-8');
                        fs.appendFileSync(OUTPUT_FILE, `✅ ${addr}   الإجمالي: ${totalStr}\n`, 'utf-8');
                        hits.sort((a, b) => b.usd - a.usd);
                        for (const h of hits) {
                            const pt = h.usd > 0.01 ? `  ≈ $${h.usd.toFixed(2)}` : (prices[h.symbol] ? '' : '  (لا سعر)');
                            fs.appendFileSync(OUTPUT_FILE, `   • ${h.chain.padEnd(22)} ${fmt(h.balance)} ${h.symbol}${pt}\n`, 'utf-8');
                        }
                        fs.appendFileSync(OUTPUT_FILE, '\n', 'utf-8');
                        foundAddrs.push({ addr, hits, total });
                    }

                    // ── تسجيل العنوان كمنتهٍ ──
                    fs.appendFileSync(END_FILE, addr + '\n', 'utf-8');
                    scheduleRemoveAddress(addr);
                }

                // ── سطر تقدم الـ chunk (واحد فقط بغض النظر عن عدد العناوين) ──
                const startIdx   = ci * BATCH_SZ + 1;
                const endIdx     = startIdx + chunk.length - 1;
                const chunkLabel = `📦 [مجموعة ${ci + 1}/${chunks.length}] (${startIdx}-${endIdx})`;
                const skipSuffix = chunkFailed.size > 0
                    ? `  ⏭️ تخطي ${chunkFailed.size}: ${[...chunkFailed].slice(0, 8).join('·')}${chunkFailed.size > 8 ? '…' : ''}`
                    : '';
                const foundCount = activeLines.filter(l => l.startsWith('   ✅')).length;
                const foundSuffix = foundCount > 0 ? `  💰 ${foundCount} محفظة` : '';
                lines.push(`\n${chunkLabel}  (${chunkElapsed}s)${foundSuffix}${skipSuffix}`);
                lines.push(...activeLines);

                // ── طباعة مرتّبة ──
                printBuf.set(ci, lines);
                flushPrint();

            } finally {
                sem.release();
            }
        }));

        // flush أي شيء متبقٍّ
        flushPrint();

        // ── ملخص أخطاء الشبكات ──
        const failedChainList = Object.entries(chainFailCount)
            .sort(([,a],[,b]) => b - a)
            .filter(([,n]) => n > 0);

        if (failedChainList.length > 0) {
            const msg = `\n⚠️  شبكات فشلت (من أصل ${evms.length} عنوان):`;
            console.log(msg);
            fs.appendFileSync(OUTPUT_FILE, msg + '\n', 'utf-8');
            for (const [sym, n] of failedChainList.slice(0, 15)) {
                const pct  = ((n / evms.length) * 100).toFixed(0);
                const err  = chainErrSamples[sym] ? `  (${chainErrSamples[sym].slice(0,40)})` : '';
                const line = `   ${sym.padEnd(12)} ${n.toLocaleString()} فشل (${pct}%)${err}`;
                console.log(line);
                fs.appendFileSync(OUTPUT_FILE, line + '\n', 'utf-8');
            }
        }

        const skipMsg = totalSkipped > 0 ? ` | ⏭️ شبكات تخطّت: ${totalSkipped.toLocaleString()}` : '';
        console.log(`\n✅ انتهى | رصيد: ${foundAddrs.length}/${evms.length} عنوان${skipMsg}`);

    } else {
        // ══════════════════════════════════════════════════════════
        //  أمر 12 — النهج الأصلي: عنوان واحد × كل الشبكات بالتوازي
        // ══════════════════════════════════════════════════════════
        for (let i = 0; i < evms.length; i++) {
            const addr = evms[i];
            console.log(`\n🔍 [${i + 1}/${evms.length}] ${addr}`);
            const t0 = Date.now();

            const chainResults = await Promise.all(
                EVM_CHAINS.map(async chain => {
                    const res = await rpcEVM(addr, chain.eps, chain.noSslVerify || false, 15000);
                    if (!res) return { failed: true, chainName: chain.name, symbol: chain.symbol };
                    const price       = prices[chain.symbol] || 0;
                    const hasBalance  = res.balance >= MIN_BALANCE;
                    const hasActivity = chain.noNonce ? false : res.txCount > 0;
                    if (!hasBalance && !hasActivity) return null;
                    return { chain: chain.name, symbol: chain.symbol, balance: res.balance,
                             usd: res.balance * price, hasBalance, hasActivity,
                             txCount: chain.noNonce ? 0 : res.txCount };
                })
            );

            const failed  = chainResults.filter(r => r?.failed);
            const hits    = chainResults.filter(r => r && !r.failed && r.hasBalance);
            const active  = chainResults.filter(r => r && !r.failed && !r.hasBalance && r.hasActivity);
            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

            if (failed.length > 0) {
                const names = failed.map(f => f.symbol).join('·');
                logError(`[أمر 12] عنوان غير مكتمل | فشل ${failed.length} شبكة: ${names} | ${addr}`);
            }

            const failSuffix = failed.length ? `  ⚠️ فشل: ${failed.length}` : '';

            if (hits.length > 0) {
                const total    = hits.reduce((s, h) => s + h.usd, 0);
                const priceTag = (h) => h.usd > 0.01 ? `  ≈ $${h.usd.toFixed(2)}` : (prices[h.symbol] ? '' : '  (لا سعر)');
                const totalStr = total > 0.01 ? `$${total.toFixed(2)}` : (hits.some(h => !prices[h.symbol]) ? '$??' : '$0.00');
                console.log(`   ✅  ${hits.length} شبكة بها رصيد  |  ${totalStr}  (${elapsed}s)${failSuffix}`);
                hits.forEach(h => console.log(`      • ${h.chain.padEnd(22)} ${fmt(h.balance)} ${h.symbol}${priceTag(h)}`));
                if (active.length > 0)
                    console.log(`   ✴️  نشطة أيضاً (رصيد صفري): ${active.map(a => a.symbol).join('·')}`);
                out('─'.repeat(62));
                out(`✅ ${addr}   الإجمالي: ${totalStr}`);
                hits.sort((a, b) => b.usd - a.usd);
                for (const h of hits) out(`   • ${h.chain.padEnd(22)} ${fmt(h.balance)} ${h.symbol}${priceTag(h)}`);
                if (active.length > 0)
                    out(`   ✴️  نشطة بدون رصيد: ${active.map(a => `${a.chain}(nonce:${a.txCount})`).join('  ')}`);
                out('');
                foundAddrs.push({ addr, hits, total });

            } else if (active.length > 0) {
                console.log(`   ✴️  نشط على ${active.length} شبكة — رصيد صفري  (${elapsed}s)${failSuffix}`);
                active.forEach(a => console.log(`      • ${a.chain.padEnd(22)} nonce: ${a.txCount}`));
                out('─'.repeat(62));
                out(`✴️  ${addr}   (نشط — رصيد صفري)`);
                active.forEach(a => out(`   • ${a.chain.padEnd(22)} nonce: ${a.txCount}`));
                out('');
                activeAddrs.push({ addr, active });

            } else {
                console.log(`   ❌  لا رصيد  (${elapsed}s)${failSuffix}`);
            }

            fs.appendFileSync(END_FILE, addr + '\n', 'utf-8');
            scheduleRemoveAddress(addr);
        }

        console.log(`\n✅ انتهى | رصيد: ${foundAddrs.length} | ✴️ نشطة: ${activeAddrs.length} | المجموع: ${evms.length}`);
    }

    console.log(`📄 النتائج: ${OUTPUT_FILE}`);
}

// ─────────────────────────────────────────────
//  COMMAND 17 — فحص EVM سريع (رصيد فقط — بدون فحص النشاط)
// ─────────────────────────────────────────────
async function runRpcEvmBalanceScan() {
    return runRpcEvmScan(true);
}

// ─────────────────────────────────────────────
//  COMMAND 13 — اختبار استجابة جميع نقاط RPC
// ─────────────────────────────────────────────
async function runRpcTest() {
    const OUTPUT_FILE = require('path').join(__dirname, 'results_rpc_test.txt');
    const out = (line) => { console.log(line); fs.appendFileSync(OUTPUT_FILE, line + '\n', 'utf-8'); };

    fs.writeFileSync(OUTPUT_FILE, `=== اختبار نقاط RPC — ${new Date().toLocaleString()} ===\n\n`, 'utf-8');
    console.log(`\n📋 أمر 13 — اختبار استجابة جميع نقاط RPC المستخدمة في الأوامر\n`);

    // ── نقاط EVM (اختبار عبر eth_blockNumber) — مُحدَّث بعد اختبار فعلي ──
    const EVM_EPS = [
        { name: 'Ethereum — publicnode',        url: 'https://ethereum.publicnode.com' },
        { name: 'Ethereum — drpc',              url: 'https://eth.drpc.org' },
        { name: 'Optimism — publicnode',        url: 'https://optimism.publicnode.com' },
        { name: 'BNB Chain — publicnode',       url: 'https://bsc.publicnode.com' },
        { name: 'BNB Chain — binance',          url: 'https://bsc-dataseed.binance.org' },
        { name: 'Polygon — publicnode',         url: 'https://polygon.publicnode.com' },
        { name: 'Polygon — drpc',               url: 'https://polygon.drpc.org' },
        { name: 'Avalanche-C — publicnode',     url: 'https://avalanche-c-chain-rpc.publicnode.com' },
        { name: 'Avalanche-C — avax',           url: 'https://api.avax.network/ext/bc/C/rpc' },
        { name: 'Fantom — rpcapi',              url: 'https://rpcapi.fantom.network' },
        { name: 'Fantom — ankr',                url: 'https://rpc.ankr.com/fantom' },
        { name: 'Base — publicnode',            url: 'https://base.publicnode.com' },
        { name: 'Base — drpc',                  url: 'https://base.drpc.org' },
        { name: 'Arbitrum — publicnode',        url: 'https://arbitrum-one.publicnode.com' },
        { name: 'Arbitrum — official',          url: 'https://arb1.arbitrum.io/rpc' },
        { name: 'zkSync Era',                   url: 'https://mainnet.era.zksync.io' },
        { name: 'Polygon zkEVM',                url: 'https://zkevm-rpc.com' },
        { name: 'Linea — linea',                url: 'https://rpc.linea.build' },
        { name: 'Linea — drpc',                 url: 'https://linea.drpc.org' },
        { name: 'Scroll',                       url: 'https://rpc.scroll.io' },
        { name: 'Gnosis — publicnode',          url: 'https://gnosis.publicnode.com' },
        { name: 'OKC',                          url: 'https://exchainrpc.okex.org' },
        { name: 'Harmony',                      url: 'https://api.harmony.one' },
        { name: 'IoTeX',                        url: 'https://babel-api.mainnet.iotex.io' },
        { name: 'ZetaChain — blockpi',          url: 'https://zetachain-evm.blockpi.network/v1/rpc/public' },
        { name: 'Sonic — soniclabs',            url: 'https://rpc.soniclabs.com' },
        { name: 'Sonic — drpc',                 url: 'https://sonic.drpc.org' },
        { name: 'Viction — viction',            url: 'https://rpc.viction.xyz' },
        { name: 'Viction — blockpi',            url: 'https://viction.blockpi.network/v1/rpc/public' },
        { name: 'EnergyWeb',                    url: 'https://rpc.energyweb.org' },
        { name: 'Oasis Emerald',                url: 'https://emerald.oasis.dev' },
        { name: 'Fuse',                         url: 'https://rpc.fuse.io' },
        { name: 'DFK Chain',                    url: 'https://subnets.avax.network/defi-kingdoms/dfk-chain/rpc' },
        { name: 'Wanchain',                     url: 'https://gwan-ssl.wandevs.org:56891' },
        { name: 'ZKFair',                       url: 'https://rpc.zkfair.io' },
        { name: 'Degen',                        url: 'https://rpc.degen.tips' },
        { name: 'Cyber',                        url: 'https://cyber.alt.technology' },
        { name: 'Syscoin',                      url: 'https://rpc.syscoin.org' },
        { name: 'Oasis Sapphire',               url: 'https://sapphire.oasis.io' },
        { name: 'Neon EVM — p2p',               url: 'https://neon-proxy-mainnet.solana.p2p.org' },
        { name: 'Neon EVM — everstake',         url: 'https://neon-mainnet.everstake.one' },
        { name: 'Filecoin EVM — glif',          url: 'https://api.node.glif.io/rpc/v1' },
        { name: 'Ronin',                        url: 'https://api.roninchain.com/rpc' },
        { name: 'Fraxtal — frax',               url: 'https://rpc.frax.com' },
        { name: 'Fraxtal — publicnode',         url: 'https://fraxtal-rpc.publicnode.com' },
        { name: 'PlatON',                       url: 'https://openapi.platon.network/rpc' },
    ];

    // ── نقاط غير EVM — مُحدَّث بعد اختبار فعلي ──
    const NON_EVM_EPS = [
        { name: 'BTC — Blockstream',            url: 'https://blockstream.info/api/blocks/tip/height' },
        { name: 'LTC — BlockCypher',            url: 'https://api.blockcypher.com/v1/ltc/main' },
        { name: 'DOGE — BlockCypher',           url: 'https://api.blockcypher.com/v1/doge/main' },
        { name: 'TRX — TronGrid',               url: 'https://api.trongrid.io/wallet/getnowblock' },
        { name: 'VeChain — mainnet',            url: 'https://mainnet.vechain.org/blocks/best' },
        { name: 'Aptos — fullnode',             url: 'https://fullnode.mainnet.aptoslabs.com/v1' },
        { name: 'Cosmos — publicnode',          url: 'https://cosmos-rest.publicnode.com/cosmos/base/tendermint/v1beta1/blocks/latest' },
        { name: 'ZEC — blockchair',             url: 'https://api.blockchair.com/zcash/stats' },
        { name: 'Terra Classic — publicnode',   url: 'https://terra-classic-lcd.publicnode.com/cosmos/base/tendermint/v1beta1/blocks/latest' },
        // SVM (Solana getHealth)
        { name: 'Solana — mainnet-beta',         url: 'https://api.mainnet-beta.solana.com',   svm: true },
        { name: 'Eclipse — mainnet',             url: 'https://mainnetbeta-rpc.eclipse.xyz',   svm: true },
        // Substrate (POST system_health)
        { name: 'Polkadot — rpc',               url: 'https://rpc.polkadot.io',               substrate: true },
        { name: 'Polkadot — publicnode',        url: 'https://polkadot-rpc.publicnode.com',   substrate: true },
        { name: 'Kusama — rpc',                 url: 'https://kusama-rpc.polkadot.io',        substrate: true },
        { name: 'Kusama — publicnode',          url: 'https://kusama-rpc.publicnode.com',     substrate: true },
        { name: 'Astar',                        url: 'https://rpc.astar.network',             substrate: true },
        { name: 'Acala — aca-api',              url: 'https://acala-rpc-0.aca-api.network',   substrate: true },
        { name: 'Centrifuge',                   url: 'https://fullnode.centrifuge.io',        substrate: true },
    ];

    // اختبار نقطة EVM
    async function testEvm(ep) {
        const t0 = Date.now();
        try {
            const r = await axios.post(ep.url, {
                jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: []
            }, { timeout: 6000 });
            const ms    = Date.now() - t0;
            const block = r.data?.result ? parseInt(r.data.result, 16) : null;
            return { ok: !!block, ms, detail: block ? `block #${block.toLocaleString()}` : 'لا block' };
        } catch (e) {
            return { ok: false, ms: Date.now() - t0, detail: e.response ? `HTTP ${e.response.status}` : e.message.slice(0, 60) };
        }
    }

    // اختبار نقطة غير EVM (GET أو Substrate POST أو SVM getHealth)
    async function testGet(ep) {
        const t0 = Date.now();
        try {
            if (ep.substrate) {
                await axios.post(ep.url, { jsonrpc: '2.0', id: 1, method: 'system_health', params: [] }, { timeout: 6000 });
            } else if (ep.svm) {
                await axios.post(ep.url, { jsonrpc: '2.0', id: 1, method: 'getHealth', params: [] }, { timeout: 6000 });
            } else {
                await axios.get(ep.url, { timeout: 6000 });
            }
            return { ok: true, ms: Date.now() - t0, detail: '' };
        } catch (e) {
            return { ok: false, ms: Date.now() - t0, detail: e.response ? `HTTP ${e.response.status}` : e.message.slice(0, 60) };
        }
    }

    // تشغيل كل الاختبارات بالتوازي
    console.log(`🔌 اختبار ${EVM_EPS.length} نقطة EVM + ${NON_EVM_EPS.length} نقطة غير EVM بالتوازي...\n`);
    const t0 = Date.now();

    const [evmRes, nonEvmRes] = await Promise.all([
        Promise.all(EVM_EPS.map(ep => testEvm(ep).then(r => ({ ...ep, ...r })))),
        Promise.all(NON_EVM_EPS.map(ep => testGet(ep).then(r => ({ ...ep, ...r })))),
    ]);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const allRes  = [...evmRes, ...nonEvmRes];
    const passed  = allRes.filter(r => r.ok).length;
    const failed  = allRes.length - passed;

    // طباعة النتائج
    out(`⏱  اكتمل خلال ${elapsed}s\n`);

    out('═'.repeat(70));
    out(`📊 النتائج الإجمالية: ✅ ${passed} تعمل  |  ❌ ${failed} فاشلة  |  المجموع: ${allRes.length}`);
    out('═'.repeat(70));

    // ── نقاط EVM ──
    out('\n── نقاط EVM (eth_blockNumber) ──────────────────────────────────────');
    for (const r of evmRes) {
        const icon = r.ok ? '✅' : '❌';
        const ms   = String(r.ms + 'ms').padStart(7);
        const detail = r.detail ? `  ${r.detail}` : '';
        out(`${icon} ${ms}  ${r.name.padEnd(42)}${detail}`);
    }

    // ── نقاط غير EVM ──
    out('\n── نقاط غير EVM ────────────────────────────────────────────────────');
    for (const r of nonEvmRes) {
        const icon = r.ok ? '✅' : '❌';
        const ms   = String(r.ms + 'ms').padStart(7);
        const detail = r.detail ? `  ${r.detail}` : '';
        out(`${icon} ${ms}  ${r.name.padEnd(42)}${detail}`);
    }

    // ── ملخص الفاشلة ──
    const failedAll = allRes.filter(r => !r.ok);
    if (failedAll.length > 0) {
        out('\n── نقاط فاشلة (للمراجعة) ───────────────────────────────────────────');
        for (const r of failedAll) {
            out(`   ❌ ${r.name.padEnd(42)}  ${r.detail}`);
        }
    }

    out('\n' + '═'.repeat(70));
    out(`📊 ✅ ${passed}/${allRes.length} نقطة RPC تعمل`);
    console.log(`\n✅ انتهى (${elapsed}s) | ${passed}/${allRes.length} تعمل`);
    console.log(`📄 النتائج: ${OUTPUT_FILE}`);
}

// ─────────────────────────────────────────────
//  COMMAND 15 — فحص نشاط 5 مسارات XRP متتالية (XRPL نيتيف)
// ─────────────────────────────────────────────
async function runXrpPathScan() {
    const OUTPUT_FILE = path.join(__dirname, 'results_xrp_paths.txt');
    const PATHS = 5;

    console.log(`\n📋 أمر 15 — فحص 5 مسارات XRP الأصلية (m/44'/144'/0'/0/0..4) على XRPL`);
    fs.writeFileSync(OUTPUT_FILE, `=== فحص مسارات XRP — ${new Date().toLocaleString()} ===\n\n`, 'utf-8');

    // ── مكتبات التشفير ──
    const { HDKey }              = require('@scure/bip32');
    const { mnemonicToSeedSync, validateMnemonic } = require('@scure/bip39');
    const { wordlist }           = require('@scure/bip39/wordlists/english');
    const { sha256 }             = require('@noble/hashes/sha2');
    const { ripemd160 }          = require('@noble/hashes/legacy');

    // ── اشتقاق عنوان XRP — m/44'/144'/0'/0/index ──
    function deriveXRP(mnemonic, index) {
        const seed    = Buffer.from(mnemonicToSeedSync(mnemonic));
        const root    = HDKey.fromMasterSeed(seed);
        const key     = root.derive(`m/44'/144'/0'/0/${index}`);
        const hash    = ripemd160(sha256(key.publicKey));
        const payload = new Uint8Array(21);
        payload[0] = 0x00;
        payload.set(hash, 1);
        return encodeRippleBase58Check(payload);
    }

    // ── قراءة العبارات ──
    if (!fs.existsSync(KEYS_FILE)) { console.log(`❌ الملف غير موجود: ${KEYS_FILE}`); return; }
    const rawLines = fs.readFileSync(KEYS_FILE, 'utf-8')
        .split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const mnemonics = rawLines
        .map(line => extractMnemonicWords(line))
        .filter(mn => mn !== null && validateMnemonic(mn, wordlist));
    console.log(`📂 العبارات: ${mnemonics.length} من أصل ${rawLines.length} سطر`);
    if (!mnemonics.length) { console.log('❌ لا توجد عبارات صالحة في keys.txt'); return; }

    // ── جلب سعر XRP ──
    let xrpPrice = 0;
    try {
        const pr = await axios.get(
            'https://api.coingecko.com/api/v3/simple/price?ids=ripple&vs_currencies=usd',
            { timeout: 8000 }
        );
        xrpPrice = pr.data?.ripple?.usd || 0;
    } catch (_) {}
    console.log(`💱 سعر XRP: $${xrpPrice}\n🚀 بدء الفحص: ${mnemonics.length} عبارة × ${PATHS} مسار\n`);

    let foundCount = 0;

    for (let m = 0; m < mnemonics.length; m++) {
        const mnemonic = mnemonics[m];
        const preview  = mnemonic.split(' ').slice(0, 3).join(' ');
        process.stdout.write(`🔍 [${m + 1}/${mnemonics.length}] ${preview}... `);

        // اشتقاق 5 عناوين وفحصها بالتوازي
        const checks = await Promise.all(
            Array.from({ length: PATHS }, (_, i) => {
                const addr = deriveXRP(mnemonic, i);
                return rpcXRP(addr)
                    .then(info => ({ i, addr, balance: info?.balance ?? 0, seq: info?.txCount ?? 0, err: null }))
                    .catch(e  => { console.error(`\n⚠️  RPC خطأ [مسار ${i}] ${addr}: ${e.message}`); return { i, addr, balance: 0, seq: 0, err: e.message }; });
            })
        );

        const hasBalance = checks.some(r => r.balance > 0);
        const hasActive  = checks.some(r => r.balance > 0 || r.seq > 0);
        if (hasBalance) foundCount++;

        // ── طباعة في السجل (النشطة + الأخطاء فقط) ──
        const activeChecks = checks.filter(r => r.balance > 0 || r.seq > 0 || r.err);
        if (activeChecks.length > 0) {
            let logEntry = `\n${'═'.repeat(60)}\n[${m + 1}] ${preview}...\n`;
            for (const r of activeChecks) {
                const usd  = r.balance * xrpPrice;
                const flag = r.balance > 0 ? '🔥🔥🔥' : r.err ? '⚠️ ' : '✴️ ';
                logEntry += `  ${flag} [${r.i}] ${r.addr}\n`;
                if (r.balance > 0) logEntry += `       XRP: ${r.balance.toFixed(6)}  @$${xrpPrice.toFixed(4)}  ≈ $${usd.toFixed(2)}\n`;
                if (r.seq > 0)     logEntry += `       Sequence: ${r.seq}\n`;
                if (r.err)         logEntry += `       ⚠️ خطأ: ${r.err}\n`;
            }
            console.log(logEntry);
        }

        // ── كتابة الملف: العبارة كاملة + النشطة فقط ──
        if (hasActive) {
            let fileEntry = `\n${'═'.repeat(60)}\n[${m + 1}] العبارة: ${mnemonic}\n`;
            for (const r of checks) {
                if (r.balance === 0 && r.seq === 0) continue;
                const usd  = r.balance * xrpPrice;
                const flag = r.balance > 0 ? '🔥🔥🔥' : '✴️ ';
                fileEntry += `  ${flag} [${r.i}] ${r.addr}\n`;
                if (r.balance > 0) fileEntry += `       XRP: ${r.balance.toFixed(6)}  @$${xrpPrice.toFixed(4)}  ≈ $${usd.toFixed(2)}\n`;
                if (r.seq > 0)     fileEntry += `       Sequence: ${r.seq}\n`;
            }
            fs.appendFileSync(OUTPUT_FILE, fileEntry + '\n', 'utf-8');
        }
    }

    const summary = `\n${'═'.repeat(60)}\n📊 انتهى | ${foundCount}/${mnemonics.length} لديهم رصيد XRP\n`;
    fs.appendFileSync(OUTPUT_FILE, summary, 'utf-8');
    console.log(summary);
    console.log(`📄 النتائج: ${OUTPUT_FILE}`);
}

// ─────────────────────────────────────────────
async function askCommand() {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        console.log('\n==============================');
        console.log('  1 — فحص رصيد التوكنات');
        console.log('  2 — فحص المراكز المفتوحة');
        console.log('  3 — فحص شامل (25 شبكة)');
        console.log('  4 — CoinStats: الأرصدة (17 شبكة)');
        console.log('  5 — CoinStats: المراكز المفتوحة');
        console.log('  6 — OKX Web3: الأرصدة (50 شبكة EVM · طلب واحد)');
        console.log('  7 — فحص العبارات (BTC·TRX·LTC·DOGE)');
        console.log('  8 — OKX DeFi: مراكز EVM المفتوحة (50 شبكة)');
        console.log('  9 — OKX DeFi: مراكز Solana المفتوحة');
        console.log(' 10 — Moralis: موافقات DeFi (Approvals — 6 شبكات)');
        console.log(' 11 — فحص العبارات RPC (سريع · بدون rate-limit)');
        console.log(' 12 — فحص عناوين EVM عبر RPC (180 شبكة · رصيد + نشاط)');
        console.log(' 13 — اختبار استجابة جميع نقاط RPC');
        console.log(' 14 — BTC + Cosmos ثقيل (مُسلسَل · لا أخطاء rate-limit)');
        console.log(' 15 — فحص 5 مسارات XRP (XRPL نيتيف)');
        console.log(' 16 — Moralis: الرصيد الأصلي (35 عنوان/طلب · 6 شبكات EVM)');
        console.log(' 17 — فحص EVM سريع: رصيد فقط (180 شبكة · بدون فحص النشاط)');
        console.log('  ح — حذف جميع ملفات النتائج');
        console.log('==============================');
        rl.question('اختر رقم الأمر: ', answer => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

async function main() {
    const cmd = process.argv[2] || await askCommand();

    if (cmd === '1') {
        // ── أمر 1: رصيد التوكنات ──
        const OUTPUT_FILE = require('path').join(__dirname, 'results_balances.txt');
        const addresses = readAddresses();
        console.log(`📋 أمر 1 — فحص الرصيد | ${addresses.length} عنوان`);
        fs.writeFileSync(OUTPUT_FILE, `=== نتائج الرصيد — ${new Date().toLocaleString()} ===\n\n`, 'utf-8');

        const BATCH_SIZE = 5; // عدد العناوين المفحوصة في آن واحد
        let found = 0;

        for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
            const batch = addresses.slice(i, i + BATCH_SIZE);

            // فحص دفعة من العناوين بالتوازي
            const batchResults = await Promise.all(
                batch.map(async (address, j) => {
                    const idx = i + j;
                    console.log(`🔍 [${idx + 1}/${addresses.length}] ${address}`);
                    const result = await checkTokenBalances(address);
                    return { address, idx, ...result };
                })
            );

            // معالجة نتائج الدفعة بالترتيب الأصلي
            for (const { address, grandTotal, lines } of batchResults) {
                if (grandTotal > 0.01) {
                    found++;
                    const entry = [`✅ ${address}`, `   الإجمالي: $${grandTotal.toFixed(2)}`, ...lines, ''].join('\n');
                    console.log(`   ✅ ${address} — $${grandTotal.toFixed(2)}`);
                    fs.appendFileSync(OUTPUT_FILE, entry + '\n', 'utf-8');
                } else {
                    console.log(`   ❌ ${address} — لا رصيد`);
                }
            }
        }

        fs.appendFileSync(OUTPUT_FILE, `=== الملخص ===\nمفحوص: ${addresses.length} | لديه رصيد: ${found}\n`, 'utf-8');
        console.log(`\n✅ انتهى | ${found}/${addresses.length} لديهم رصيد`);
        console.log(`📄 النتائج: ${OUTPUT_FILE}`);

    } else if (cmd === '2') {
        // ── أمر 2: المراكز المفتوحة في البروتوكولات ──
        const OUTPUT_FILE = require('path').join(__dirname, 'results_positions.txt');
        const addresses = readAddresses();
        console.log(`📋 أمر 2 — فحص المراكز المفتوحة | ${addresses.length} عنوان`);
        console.log(`🔎 البروتوكولات: Aave V3 · Lido stETH · Compound V3 · Uniswap V3 LP\n`);
        fs.writeFileSync(OUTPUT_FILE, `=== نتائج المراكز المفتوحة — ${new Date().toLocaleString()} ===\n\n`, 'utf-8');

        let found = 0;
        for (let i = 0; i < addresses.length; i++) {
            const address = addresses[i];
            console.log(`🔍 [${i + 1}/${addresses.length}] ${address}`);
            const positions = await checkOpenPositions(address);

            if (positions.length > 0) {
                found++;
                const lines = positions.map(p => `   - ${p.protocol}: ${p.details}`);
                const entry = [`✅ ${address}`, ...lines, ''].join('\n');
                console.log(`   ✅ ${positions.length} مركز مفتوح`);
                positions.forEach(p => console.log(`      → ${p.protocol}: ${p.details}`));
                fs.appendFileSync(OUTPUT_FILE, entry + '\n', 'utf-8');
            } else {
                console.log(`   ❌ لا مراكز مفتوحة`);
            }
        }

        fs.appendFileSync(OUTPUT_FILE, `=== الملخص ===\nمفحوص: ${addresses.length} | لديه مراكز: ${found}\n`, 'utf-8');
        console.log(`\n✅ انتهى | ${found}/${addresses.length} لديهم مراكز مفتوحة`);
        console.log(`📄 النتائج: results_positions.txt`);

    } else if (cmd === '3') {
        // ── أمر 3: فحص شامل عبر كل الشبكات المدعومة في Enso (24 شبكة) ──
        // الأمر 1 يفحص 4 شبكات فقط — هذا يفحص كل ما يدعمه Enso
        const ALL_ENSO_CHAINS = [
            1, 10, 56, 100, 130, 137, 143, 146, 324, 480,
            999, 1329, 1868, 4217, 4326, 8453, 9745, 42161,
            43114, 57073, 59144, 80094, 98866, 747474, 11155111
        ];

        const OUTPUT_FILE = require('path').join(__dirname, 'results_all_chains.txt');
        const addresses = readAddresses();
        console.log(`📋 أمر 3 — فحص شامل | ${addresses.length} عنوان | ${ALL_ENSO_CHAINS.length} شبكة`);
        console.log(`🔎 Enso API · GET /v1/wallet/balances · ${ALL_ENSO_CHAINS.length} شبكة مدعومة\n`);
        fs.writeFileSync(OUTPUT_FILE, `=== نتائج الفحص الشامل (${ALL_ENSO_CHAINS.length} شبكة) — ${new Date().toLocaleString()} ===\n\n`, 'utf-8');

        let found = 0;
        for (let i = 0; i < addresses.length; i++) {
            const address = addresses[i];
            console.log(`🔍 [${i + 1}/${addresses.length}] ${address}`);

            // فحص كل الشبكات بشكل متوازٍ لكل عنوان
            const chainResults = await Promise.all(
                ALL_ENSO_CHAINS.map(chainId =>
                    axios.get('https://api.enso.build/api/v1/wallet/balances', {
                        params: { chainId, eoaAddress: address, useEoa: true },
                        headers: { Authorization: `Bearer ${API_KEY}` },
                        timeout: 12000
                    }).then(r => r.data).catch(() => [])
                )
            );

            const active = [];
            let totalUSD = 0;

            chainResults.forEach((assets, idx) => {
                if (!assets || assets.length === 0) return;
                const chainId = ALL_ENSO_CHAINS[idx];
                assets.forEach(asset => {
                    const balance = asset.amount / Math.pow(10, asset.decimals);
                    const usdValue = balance * asset.price;
                    if (usdValue > 0.01) {
                        totalUSD += usdValue;
                        active.push(`   - [Chain ${chainId}] ${asset.symbol}: ${fmt(balance)} ($${usdValue.toFixed(2)})`);
                    }
                });
            });

            if (active.length > 0) {
                found++;
                console.log(`   ✅ ${active.length} توكن | إجمالي: $${totalUSD.toFixed(2)}`);
                const entry = [
                    `✅ ${address}`,
                    `   الإجمالي: $${totalUSD.toFixed(2)}`,
                    ...active,
                    ''
                ].join('\n');
                fs.appendFileSync(OUTPUT_FILE, entry + '\n', 'utf-8');
            } else {
                console.log(`   ❌ لا رصيد`);
            }
        }

        fs.appendFileSync(OUTPUT_FILE, `=== الملخص ===\nمفحوص: ${addresses.length} | لديه رصيد: ${found}\n`, 'utf-8');
        console.log(`\n✅ انتهى | ${found}/${addresses.length} لديهم رصيد عبر الشبكات الموسّعة`);
        console.log(`📄 النتائج: ${OUTPUT_FILE}`);

    } else if (cmd === '4') {
        await runCoinStatsBalances();

    } else if (cmd === '5') {
        await runCoinStatsDefi();

    } else if (cmd === '6') {
        await runOKXBalances();

    } else if (cmd === '7') {
        await runSeedScan();

    } else if (cmd === '8') {
        await runOKXEvmDefi();

    } else if (cmd === '9') {
        await runOKXSolanaDefi();

    } else if (cmd === '10') {
        await runMoralisApprovals();

    } else if (cmd === '11') {
        await runRpcSeedScan();

    } else if (cmd === '12') {
        await runRpcEvmScan();

    } else if (cmd === '13') {
        await runRpcTest();

    } else if (cmd === '14') {
        await runRpcThrottledScan();

    } else if (cmd === '15') {
        await runXrpPathScan();

    } else if (cmd === '16') {
        await runMoralisNativeBalances();

    } else if (cmd === '17') {
        await runRpcEvmBalanceScan();

    } else if (cmd === 'ح') {
        const RESULTS_FILES = [
            'results_balances.txt', 'results_positions.txt', 'results_all_chains.txt',
            'results_cs_balances.txt', 'results_cs_defi.txt', 'results_okx_balances.txt',
            'results_seeds.txt', 'results_evm_defi.txt', 'results_sol_defi.txt',
            'results_approvals.txt', 'results_moralis_native.txt', 'results_rpc_seeds.txt',
            'results_rpc_seeds_14.txt', 'results_rpc_evm.txt', 'results_rpc_evm_fast.txt',
            'results_positions.txt',
        ];
        console.log('\n🗑️  حذف ملفات النتائج...');
        let deleted = 0, notFound = 0;
        for (const name of RESULTS_FILES) {
            const filePath = path.join(__dirname, name);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`   ✅ حُذف: ${name}`);
                deleted++;
            } else {
                notFound++;
            }
        }
        console.log(`\n✅ تم — حُذف ${deleted} ملف${notFound ? ` (${notFound} غير موجود)` : ''}`);

    } else {
        console.log(`رقم غير صحيح. اختر من 1 إلى 17، أو ح للحذف.`);
    }
}

if (require.main === module) {
    main();
} else {
    module.exports = { deriveAddressesExtended, checkEntryRpc, fetchAllRpcPrices, CMD14_CHAINS };
}
