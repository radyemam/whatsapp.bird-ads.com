import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, downloadMediaMessage } from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import { CONFIG } from '../config.js';
import User from '../models/User.js';
import Message from '../models/Message.js';
import Instruction from '../models/Instruction.js';
import { Op, Sequelize } from 'sequelize';

// V6_STABLE_VERSION
console.log("✅ [V6_SIGNATURE] botController.js Loaded");

// Setup FFmpeg
ffmpeg.setFfmpegPath(ffmpegPath);

// Logger
const logger = pino({ level: 'silent' });

// Store active sessions: userId -> socket
const sessions = new Map();

async function callVertexAI(remoteJid, userText, mediaBuffer = null, mediaMime = null, userId) {
    // 1. Fetch User Instructions from Instructions table
    const user = await User.findByPk(userId);
    const allInstructions = await Instruction.findAll({
        where: { UserId: userId, isActive: true },
        order: [['order', 'ASC'], ['createdAt', 'DESC']]
    });

    // Combine all instructions into one system prompt
    // 🧠 SMART INSTRUCTION FILTERING 🧠
    // We only load instructions that are:
    // 1. Type 'global' (Always active)
    // 2. Type 'topic' AND their keywords match the user's query

    let filteredInstructions = [];
    let loadedTopics = [];

    const normalizeText = (text) => text ? text.toLowerCase().trim() : "";
    const userQuery = normalizeText(userText); // userText is the incoming message

    if (allInstructions.length > 0) {
        filteredInstructions = allInstructions.filter(inst => {
            // ALWAYS include global instructions
            if (inst.type === 'global') return true;

            // For 'topic' instructions, check keywords
            if (inst.keywords) {
                const keywords = inst.keywords.split(',').map(k => normalizeText(k));
                // Check if ANY keyword exists in the user query
                const isRelevant = keywords.some(k => k.length > 2 && userQuery.includes(k));

                if (isRelevant) {
                    loadedTopics.push(inst.clientName);
                    return true;
                }
            }
            return false;
        });
    }

    console.log(`🤖 Smart Context: Loaded ${filteredInstructions.length} instructions (Global + [${loadedTopics.join(', ')}])`);


    // Combine filtered instructions into one system prompt
    let systemInstruction = CONFIG.SYSTEM_INSTRUCTIONS;
    if (filteredInstructions.length > 0) {
        // Append custom instructions to the base identity
        systemInstruction += '\n\n' + filteredInstructions.map(inst => inst.content).join('\n\n');

        // SMART IMAGE INJECTION OPTIMIZATION
        // Only inject image descriptions if the user message contains visual keywords or is multimedia (audio/image)
        const visualKeywords = /(صورة|صور|شكل|شكال|موديل|ديزاين|الوان|لون|وريني|فرجني|اشوف|معاينة|عينة|تفاصيل|image|photo|pic|picture|show|see|look|color|design|details)/i;
        const shouldInjectImages = (userText && visualKeywords.test(userText)) || mediaBuffer;

        if (shouldInjectImages) {
            // Add information about available images (Multi-Image Support) - ONLY for filtered instructions
            const instructionsWithImages = filteredInstructions.filter(inst => inst.imageUrl);
            if (instructionsWithImages.length > 0) {
                systemInstruction += '\n\n📸 **الصور المتاحة (المعرض):**\n';

                instructionsWithImages.forEach(inst => {
                    let images = [];
                    try {
                        if (inst.imageUrl.startsWith('[')) {
                            images = JSON.parse(inst.imageUrl);
                        } else {
                            images = [{ url: inst.imageUrl, description: 'الصورة الأساسية' }];
                        }
                    } catch (e) {
                        images = [{ url: inst.imageUrl, description: 'الصورة الأساسية' }];
                    }

                    if (images.length > 0) {
                        systemInstruction += `- موضوع: "${inst.clientName}" يحتوي على الصور التالية:\n`;
                        images.forEach((img, idx) => {
                            const desc = img.description || `صورة رقم ${idx + 1}`;
                            systemInstruction += `  • وصف الصورة: "${desc}"\n`;
                        });
                    }
                });
                systemInstruction += '\n💡 **تعليمات هامة جداً لإرسال الصور:**\n';
                systemInstruction += '1. عندما يطلب العميل صوراً (سواء نصياً أو صوتياً)، **يجب** أن تذكر "اسم المنتج" بدقة في ردك.\n';
                systemInstruction += '2. ⛔ **ممنوع الردود العامة** مثل "تفضل الصور" أو "هذه صور الموديلات".\n';
                systemInstruction += '3. ✅ **الصحيح:** "تفضل، هذه صور [اسم المنتج] المتاحة" (مثال: "تفضل صور الجينز" أو "إليك صور الهودي").\n';
                systemInstruction += '5. 🎤 **في حالة الرسائل الصوتية:** سيظهر لك النص "رسالة صوتية". في هذه الحالة، يجب أن تكون دقيقاً جداً وتذكر اسم المنتج. لا تقل "صور الموديلات" أبداً، بل قل "صور [المنتج]".\n';
                systemInstruction += '6. مثال: لو العميل سأل بصوته عن "الجينز"، لا ترد "تفضل صور الموديلات"، بل رد: "تفضل صور الجينز المتاحة".\n';
                systemInstruction += '7. 🛑 **قاعدة هامة للقوائم:** لو العميل سأل عن "أسعار الجينز" وعندك أنواع كتير (كلاسيك، وايد ليج، إلخ)، **لا ترسل صورهم كلهم مرة واحدة**.\n';
                systemInstruction += '8. خطأ: "عندنا كلاسيك بـ 100 (ودي صورته) ووايد ليج بـ 200 (ودي صورته)..."\n';
                systemInstruction += '9. صح: اشرح الأسعار كتابة فقط أولاً، وبعدين اسأله: "تحب تشوف صور لأنهي موديل فيهم؟".\n';
                systemInstruction += '10. لما العميل يختار "الوايد ليج"، ساعتها بس رد: "تمام، دي صور الوايد ليج".\n';
            }
        }
    }

    // 2. Fetch Chat History from DB
    const dbMessages = await Message.findAll({
        where: { remoteJid, UserId: userId },
        limit: 10,
        order: [['createdAt', 'DESC']]
    });

    const history = dbMessages.reverse().map(msg => ({
        role: msg.role,
        parts: [{ text: msg.content }]
    }));

    // 3. Prepare Current Request
    const currentParts = [];
    if (userText) currentParts.push({ text: userText });
    if (mediaBuffer) {
        currentParts.push({
            inline_data: {
                mime_type: mediaMime,
                data: mediaBuffer.toString('base64')
            }
        });
    }

    // Add current message to history for the API call
    history.push({ role: "user", parts: currentParts });

    const contents = history;

    // Vertex AI URL
    const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${CONFIG.PROJECT_ID}/locations/us-central1/publishers/google/models/${CONFIG.MODEL_NAME}:generateContent?key=${CONFIG.USER_KEY}`;

    const payload = {
        contents: contents,
        system_instruction: {
            parts: [{ text: systemInstruction }]
        }
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Vertex AI Error ${response.status}: ${errText}`);
        }

        const data = await response.json();
        const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;

        // --- PRECISE TOKEN COUNTING (OFFICIAL) ---
        let totalTokens = 0;

        if (data.usageMetadata && data.usageMetadata.totalTokenCount) {
            // Use OFFICIAL Google Usage Metadata
            totalTokens = data.usageMetadata.totalTokenCount;
            // console.log(`📊 Official Token Usage: ${totalTokens} (Prompt: ${data.usageMetadata.promptTokenCount}, Candidates: ${data.usageMetadata.candidatesTokenCount})`);
        } else {
            // FALLBACK TO ESTIMATION (If metadata is missing)
            // Estimate: 4 chars = 1 token (approx)
            let totalChars = 0;

            // Input chars
            totalChars += systemInstruction.length;
            contents.forEach(msg => {
                if (msg.parts && msg.parts[0] && msg.parts[0].text) {
                    totalChars += msg.parts[0].text.length;
                }
            });

            // Output chars
            if (reply) {
                totalChars += reply.length;
            }

            totalTokens = Math.ceil(totalChars / 4);
            // console.log(`⚠️ Estimated Token Usage: ${totalTokens} (Metadata missing)`);
        }

        // Update user with precise count
        if (user) {
            await user.increment('total_tokens', { by: totalTokens });
        }
        // ------------------------

        return reply || null;
    } catch (error) {
        console.error("AI Call Failed:", error);
        return "عذراً، حصل مشكلة في الاتصال بالذكاء الاصطناعي.";
    }
}

async function handleOrderCompletion(sock, customerJid, lastMessage, aiResponse, userId) {
    try {
        // 1. Extract order number from AI response
        const orderNumMatch = aiResponse.match(/رقم الطلب:\s*(\d+)/);
        const orderNum = orderNumMatch ? orderNumMatch[1] : "N/A";

        // 2. Get customer name from WhatsApp
        let customerName = customerJid.split('@')[0]; // Default: phone number
        try {
            const contact = await sock.onWhatsApp(customerJid);
            if (contact && contact[0] && contact[0].notify) {
                customerName = contact[0].notify;
            }
        } catch (error) {
            console.log("⚠️ Could not fetch customer name, using JID");
        }

        // 3. Find the appropriate instruction with actionTarget
        const instructions = await Instruction.findAll({
            where: { UserId: userId },
            order: [['order', 'ASC'], ['createdAt', 'DESC']]
        });

        let targetGroup = null;

        // Find instruction with actionTarget set
        for (const inst of instructions) {
            if (inst.actionTarget) {
                targetGroup = inst.actionTarget;
                console.log(`📤 Target group found: ${targetGroup}`);
                break;
            }
        }

        if (!targetGroup) {
            console.log("⚠️ No actionTarget set in instructions. Skipping group forward.");
            return;
        }

        // 4. Extract order summary from chat history
        const messages = await Message.findAll({
            where: { remoteJid: customerJid, UserId: userId },
            limit: 30,
            order: [['createdAt', 'DESC']]
        });

        // Find the confirmation message (with "برجاء التأكيد") or fallback to last AI message
        let orderSummary = "لم يتم العثور على ملخص الطلب";

        // Strategy 1: Look for "برجاء التأكيد"
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'model' && messages[i].content.includes("برجاء التأكيد")) {
                const content = messages[i].content;
                const summaryMatch = content.split("برجاء التأكيد")[0];
                if (summaryMatch) {
                    orderSummary = summaryMatch.trim().replace(/\*\*$/g, '').trim();
                }
                break;
            }
        }

        // Strategy 2: Fallback to the immediate last AI message (before the current success message)
        if (orderSummary === "لم يتم العثور على ملخص الطلب") {
            // Filter for model messages, excluding the current one (which likely has 'تم ارسال طلبك')
            const aiMessages = messages.filter(m => m.role === 'model' && !m.content.includes("تم إرسال طلبك"));
            if (aiMessages.length > 0) {
                // Get the most recent one
                orderSummary = aiMessages[aiMessages.length - 1].content;
                console.log("⚠️ Used fallback strategy for order summary.");
            }
        }

        // 5. Determine service type from summary
        let serviceType = "طلب جديد";
        if (orderSummary.includes("بوست") || orderSummary.includes("منشور")) {
            serviceType = "طلب تصميم بوست جديد";
        } else if (orderSummary.includes("لوجو")) {
            serviceType = "طلب تصميم لوجو جديد";
        } else if (orderSummary.includes("كافر") || orderSummary.includes("غلاف")) {
            serviceType = "طلب تصميم كافر فوتو جديد";
        } else if (orderSummary.includes("بانر")) {
            serviceType = "طلب تصميم بانر جديد";
        } else if (orderSummary.includes("فيديو") || orderSummary.includes("ريلز") || orderSummary.includes("مونتاج")) {
            serviceType = "طلب فيديو جديد";
        } else if (orderSummary.includes("محتوى") || orderSummary.includes("كتابة")) {
            serviceType = "طلب كتابة محتوى جديد";
        } else if (orderSummary.includes("إعلان ممول")) {
            serviceType = "طلب إعلان ممول جديد";
        }

        // 6. Build group message
        let groupMsg = `📋 ${serviceType}\n\n`;
        groupMsg += `👤 العميل: ${customerName}\n`;
        groupMsg += `📞 رقم التليفون: ${customerJid.split('@')[0]}\n`;
        groupMsg += `🔢 رقم الطلب: ${orderNum}\n\n`;
        groupMsg += orderSummary;

        // 7. Search for group by name
        console.log(`🔍 Searching for group: "${targetGroup}"...`);

        const groups = await sock.groupFetchAllParticipating();
        let targetGroupJid = null;

        for (const groupId in groups) {
            const group = groups[groupId];
            if (group.subject === targetGroup) {
                targetGroupJid = groupId;
                console.log(`✅ Found group: ${targetGroup} (${groupId})`);
                break;
            }
        }

        if (!targetGroupJid) {
            console.log(`❌ Group "${targetGroup}" not found!`);
            console.log(`Available groups: ${Object.values(groups).map(g => g.subject).join(', ')}`);
            return;
        }

        // 8. Send message to group
        await sock.sendMessage(targetGroupJid, { text: groupMsg });
        console.log(`✅ Order forwarded to group "${targetGroup}"!`);

    } catch (error) {
        console.error("❌ handleOrderCompletion Error:", error);
    }
}

export const startSession = async (userId, io, phoneNumber = null) => {
    // Enable Auto Reply in DB
    const user = await User.findByPk(userId);

    // Check if resuming from Manual Pause
    if (user.connection_status === 'paused_manual' || user.pause_until) {
        console.log(`[Dashboard] Resuming manual pause for User ${userId}`);

        // Notify Control Group
        if (user.control_group_jid && sessions.has(userId)) {
            const sock = sessions.get(userId);
            if (sock.user) {
                try {
                    await sock.sendMessage(user.control_group_jid, { text: '✅ تم تشغيل البوت من لوحة التحكم.' });
                } catch (e) {
                    console.error("Error notifying control group:", e);
                }
            }
        }
    }

    await User.update({ auto_reply: true, connection_status: 'online', pause_until: null }, { where: { id: userId } });

    if (sessions.has(userId)) {
        const sock = sessions.get(userId);
        // Only return 'already_running' if actually authenticated
        if (sock.user) {
            io.to(`user_${userId}`).emit('status', { status: 'online', phone: sock.user.id.split(':')[0].split('@')[0], name: sock.user.name || "My Bot" });
            return { status: 'already_running', message: 'Bot Auto-Reply Enabled' };
        }
        // If session exists but not authenticated (stuck in QR loop?), better to just continue and let it re-init or just return status
        // Check if connection is working
        // return { status: 'connecting', message: 'Waiting for connection...' };
    }

    const authPath = path.join('sessions', `auth_info_${userId}`);
    if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: !phoneNumber, // Only print QR if no phone number
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        browser: ["Ubuntu", "Chrome", "20.0.04"], // Simulate a browser
        generateHighQualityLinkPreview: true,
    });

    sessions.set(userId, sock);

    // Pairing Code Logic
    if (phoneNumber && !sock.authState.creds.registered) {
        // Sanitize phone number (remove +, spaces, dashes)
        const sanitizedPhone = phoneNumber.replace(/[^0-9]/g, '');

        setTimeout(async () => {
            try {
                console.log(`Requesting pairing code for: ${sanitizedPhone}`);
                const code = await sock.requestPairingCode(sanitizedPhone);
                console.log(`Pairing Code for User ${userId}: ${code}`);
                io.to(`user_${userId}`).emit('pairing_code', code);
            } catch (err) {
                console.error("Pairing Code Error:", err);
                io.to(`user_${userId}`).emit('pairing_error', err.message);
            }
        }, 4000); // Wait 4s to ensure connection init
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !phoneNumber) io.to(`user_${userId}`).emit('qr_code', qr); // Only emit QR if not using pairing code

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                sessions.delete(userId);
                startSession(userId, io);
            } else {
                console.log(`User ${userId} logged out`);
                // Clear linked phone number and update status
                await User.update({ linked_phone_number: null, auto_reply: false, connection_status: 'not_registered' }, { where: { id: userId } });

                sessions.delete(userId);
                io.to(`user_${userId}`).emit('status', 'not_registered');
                try {
                    fs.rmSync(authPath, { recursive: true, force: true });
                } catch (e) {
                    console.error("Error removing auth path:", e);
                }
            }
        } else if (connection === 'open') {
            console.log(`User ${userId} connected`);
            const id = sock.user.id.split(':')[0].split('@')[0];
            const name = sock.user.name || "My Bot";

            // SAVE PHONE and STATUS TO DB
            await User.update({ linked_phone_number: id, connection_status: 'online' }, { where: { id: userId } });

            io.to(`user_${userId}`).emit('status', { status: 'online', phone: id, name: name });
        }
    });

    const ABKARINO_API_URL = 'http://localhost:8000/api/bot/chat';

    async function callAbkarinoAPI(text, userId) {
        try {
            const response = await fetch(ABKARINO_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: userId,
                    message: text,
                    history: [] // History is managed by agent internally or we can fetch it
                })
            });

            if (!response.ok) {
                console.error(`Abkarino API Error: ${response.status} ${response.statusText}`);
                return "عذراً، حدث خطأ في الاتصال بعبقرينو.";
            }

            const data = await response.json();
            return data.response;
        } catch (error) {
            console.error("Abkarino API Call Failed:", error);
            return "عذراً، عبقرينو مش متاح حالياً.";
        }
    }

    // ... (Existing functions)

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        const messageType = Object.keys(msg.message)[0];

        let text = "";
        if (messageType === 'conversation') text = msg.message.conversation;
        else if (messageType === 'extendedTextMessage') text = msg.message.extendedTextMessage.text;
        else if (messageType === 'audioMessage') text = "رسالة صوتية";

        // 1. Save User Message to DB (ALWAYS)
        if (text) {
            const savedMsg = await Message.create({
                UserId: userId,
                remoteJid,
                role: 'user',
                content: text
            });
            io.to(`user_${userId}`).emit('new_message', savedMsg);
        }

        // 2. Check for "Lina Control" or "Abkarino" Group Message (High Priority)
        if (remoteJid.endsWith('@g.us')) {
            try {
                // Fetch group metadata to check name
                const groupMetadata = await sock.groupMetadata(remoteJid);

                // Check for "Lina" Group (Control Center)
                if (groupMetadata.subject && (groupMetadata.subject.includes("لينا") || groupMetadata.subject.toLowerCase().includes("lina"))) {
                    console.log(`🔧 Lina Control Group Message: ${text}`);

                    const normalizeCmd = text.trim().toLowerCase();
                    const user = await User.findByPk(userId);

                    // CRITICAL: Check subscription expiry FIRST
                    if (user.expiry_date) {
                        const today = new Date().toISOString().split('T')[0];
                        if (user.expiry_date < today) {
                            console.log(`[Lina Group] Subscription expired for user ${userId}. Ignoring command.`);
                            return;
                        }
                    }

                    // 1. STOP Command
                    if (normalizeCmd === 'إيقاف' || normalizeCmd === 'ايقاف' || normalizeCmd === 'stop') {
                        user.connection_status = 'paused_manual';
                        user.pause_until = null;
                        user.control_group_jid = remoteJid;
                        await user.save();
                        await sock.sendMessage(remoteJid, { text: '✅ تم إيقاف البوت عن الرد تلقائياً على جميع المحادثات.' });
                        return;
                    }

                    // 2. START Command
                    if (normalizeCmd === 'تشغيل' || normalizeCmd === 'start') {
                        user.connection_status = 'online';
                        user.pause_until = null;
                        user.control_group_jid = remoteJid;
                        await user.save();
                        await sock.sendMessage(remoteJid, { text: '✅ تم إعادة تشغيل البوت للرد على الجميع.' });
                        return;
                    }

                    // 3. WAIT Command
                    if (normalizeCmd.startsWith('انتظر') || normalizeCmd.startsWith('wait')) {
                        // Parse duration or ask for it
                        // Simple parsing for now: "انتظر 15 دقيقة"
                        // Regex to capture number and unit
                        const match = normalizeCmd.match(/(\d+)\s*(دقيقة|دقائق|ساعة|ساعات|يوم|أيام|min|mins|hour|hours|day|days)/);

                        if (match) {
                            const num = parseInt(match[1]);
                            const unit = match[2];
                            let durationMs = 0;

                            if (unit.includes('د') || unit.includes('min')) durationMs = num * 60 * 1000;
                            else if (unit.includes('س') || unit.includes('hour')) durationMs = num * 60 * 60 * 1000;
                            else if (unit.includes('ي') || unit.includes('day')) durationMs = num * 24 * 60 * 60 * 1000;

                            const unlockTime = new Date(Date.now() + durationMs);

                            user.connection_status = 'paused_manual';
                            user.pause_until = unlockTime;
                            user.control_group_jid = remoteJid;
                            await user.save();

                            const dateStr = unlockTime.toLocaleDateString('en-GB'); // DD/MM/YYYY
                            const timeStr = unlockTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: 'numeric', hour12: true });

                            await sock.sendMessage(remoteJid, { text: `✅ تم إيقاف الرد مؤقتاً لمدة ${num} ${unit}.\n\nسيتم الاستئناف تلقائياً في:\n${dateStr}\nالساعة\n${timeStr}` });

                        } else {
                            // If just "انتظر", ask for duration? 
                            // For simplicity in V1, let's just ask to specify.
                            await sock.sendMessage(remoteJid, { text: '⚠️ يرجى تحديد المدة. مثال: "انتظر 15 دقيقة" أو "انتظر 2 ساعة".' });
                        }
                        return;
                    }

                    // If message is in Lina group but NOT a command, ignore it (do not send to AI)
                    return;
                }

                // Check for "عبقرينو" Group Message (High Priority) - Original Logic kept but moved after Lina check
                if (groupMetadata.subject && groupMetadata.subject.includes("عبقرينو")) {
                    console.log(`🤖 Abkarino Group Message: ${text}`);

                    // Simulate Typing
                    await sock.sendPresenceUpdate('composing', remoteJid);

                    // Call Abkarino API
                    const replyText = await callAbkarinoAPI(text, userId);

                    // Stop Typing
                    await sock.sendPresenceUpdate('paused', remoteJid);

                    // Send Reply
                    await sock.sendMessage(remoteJid, { text: replyText });

                    // Save Bot Reply
                    const savedResponse = await Message.create({
                        UserId: userId,
                        remoteJid,
                        role: 'model',
                        content: replyText
                    });
                    io.to(`user_${userId}`).emit('new_message', savedResponse);
                    return; // Stop processing further
                }
            } catch (err) {
                console.error("Error checking group name:", err);
            }
        }

        // 3. Check Auto-Reply Status (For Customers)
        const user = await User.findByPk(userId);
        if (!user.auto_reply) {
            console.log(`Auto-reply disabled for user ${userId}. Skipping response.`);
            return;
        }

        // 3.1. Check Subscription Expiry
        if (user.expiry_date) {
            const today = new Date().toISOString().split('T')[0];
            if (user.expiry_date < today) {
                console.log(`Subscription expired for user ${userId}. Skipping response.`);
                return;
            }
        }

        // 3.5. Check Manual Pause / Timer
        // If status is 'paused_manual', check if we have a timer
        if (user.connection_status === 'paused_manual') {
            if (user.pause_until) {
                // Timer is active
                if (new Date() < new Date(user.pause_until)) {
                    console.log(`Bot paused for user ${userId} until ${user.pause_until}`);
                    return;
                    // If timer expired, it should be caught by cron, but if we catch it here first:
                } else {
                    // Timer expired just now, let's auto-resume?
                    // Better let the background job handle notification, or handle here silently.
                    // For consistency, let's treat it as active if time passed.
                    console.log(`User ${userId} pause time expired. Resuming flow.`);
                    user.connection_status = 'online';
                    user.pause_until = null;
                    await user.save();
                    // Notify admin group? Maybe later in background job. 
                }
            } else {
                // Infinite manual pause
                console.log(`Bot manually paused for user ${userId}.`);
                return;
            }
        }

        // 4. Ignore Group Messages (Safety - Already handled Abkarino & Lina group above)
        if (remoteJid.endsWith('@g.us')) {
            // Double check if it's the control group, just in case
            try {
                const groupMetadata = await sock.groupMetadata(remoteJid);
                if (groupMetadata.subject && (groupMetadata.subject.includes("لينا") || groupMetadata.subject.toLowerCase().includes("lina"))) {
                    console.log(`[Safety Check] Allowed Lina group message to pass through ignore block: ${remoteJid}`);
                    // Allowed Lina group msg to proceed to AI.
                } else {
                    console.log(`Ignoring other group message from: ${remoteJid}`);
                    return;
                }
            } catch (e) {
                console.log(`Ignoring group message (metadata fetch failed) from: ${remoteJid}`);
                return;
            }
        }

        // 5. Process AI Response (Vertex AI for Customers)
        // Simulate Typing
        await sock.sendPresenceUpdate('composing', remoteJid);

        let replyText = "";
        if (messageType === 'conversation' || messageType === 'extendedTextMessage') {
            replyText = await callVertexAI(remoteJid, text, null, null, userId);
        } else if (messageType === 'audioMessage') {
            // ... (Voice handling logic same as before)
            // For brevity, assuming voice logic remains similar or reusing existing callVertexAI with voice support
            console.log("🎤 Processing audio message...");
            try {
                const buffer = await downloadMediaMessage(
                    msg,
                    'buffer',
                    {},
                    { logger, reuploadRequest: sock.updateMediaMessage }
                );

                const tempInput = `temp_${Date.now()}.ogg`;
                const tempOutput = `temp_${Date.now()}.mp3`;
                fs.writeFileSync(tempInput, buffer);

                await new Promise((resolve, reject) => {
                    ffmpeg(tempInput)
                        .toFormat('mp3')
                        .on('end', resolve)
                        .on('error', reject)
                        .save(tempOutput);
                });

                const mp3Buffer = fs.readFileSync(tempOutput);
                replyText = await callVertexAI(remoteJid, "رسالة صوتية", mp3Buffer, "audio/mp3", userId);

                if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
                if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);

            } catch (e) {
                console.error("❌ Voice Error:", e);
                replyText = "عذراً، مش عارف اسمع الصوت ده دلوقتي.";
            }
        }

        // Stop Typing
        await sock.sendPresenceUpdate('paused', remoteJid);


        if (replyText) {
            // FIX: Clean up Markdown links [text](url) -> url (if text is similar) to prevent duplication in WhatsApp
            replyText = replyText.replace(/\[([^\]]*?)\]\(([^)]+?)\)/g, (match, text, url) => {
                const cleanText = text.trim();
                const cleanUrl = url.trim();
                // If text is same as URL or URL contains text (typical AI behavior for raw links), just show URL
                if (cleanText === cleanUrl || cleanUrl.includes(cleanText)) {
                    return cleanUrl;
                }
                // Otherwise show: Text (URL)
                return `${cleanText}: ${cleanUrl}`;
            });

            await sock.sendMessage(remoteJid, { text: replyText });

            const savedResponse = await Message.create({
                UserId: userId,
                remoteJid,
                role: 'model',
                content: replyText
            });
            io.to(`user_${userId}`).emit('new_message', savedResponse);

            // 4. Send image if mentioned in reply
            // Regex to match "image", "his image", "the image", "images", "picture" in Arabic
            const imageRegex = /(صورة|صورته|الصورة|الصور|صور|صوره|صورتة)/;

            if (imageRegex.test(replyText)) {
                console.log("\n--- [V6_SIGNATURE] IMAGE SCAN START ---");
                console.log(`🤖 AI Intent: Image`);
                console.log(`👤 User: "${text}"`);
                console.log(`🤖 Reply: "${replyText}"`);

                const instructions = await Instruction.findAll({
                    where: { UserId: userId },
                    order: [['order', 'ASC'], ['createdAt', 'DESC']]
                });

                console.log(`📚 Instructions found: ${instructions.length}`);

                let imagesToSend = [];
                const normalize = (t) => t ? t.trim().toLowerCase().replace(/[^\w\s\u0621-\u064A]/g, '') : "";

                const normReply = normalize(replyText);
                const normUser = normalize(text);

                for (const inst of instructions) {
                    if (!inst.imageUrl) continue;

                    const instName = inst.clientName.trim();
                    const normName = normalize(instName);
                    const normContent = normalize(inst.content);

                    console.log(`   🔎 Checking: "${instName}"`);

                    let images = [];
                    try {
                        if (inst.imageUrl.startsWith('[')) images = JSON.parse(inst.imageUrl);
                        else images = [{ url: inst.imageUrl, description: 'الصورة الأساسية' }];
                    } catch (e) {
                        images = [{ url: inst.imageUrl, description: 'الصورة الأساسية' }];
                    }

                    let found = false;

                    // Match logic
                    const keywords = normName.split(/\s+/).filter(k => k.length > 2);
                    const kMatch = keywords.some(k => normReply.includes(k) || normUser.includes(k));
                    const cMatch = normUser.length > 4 && normContent.includes(normUser);
                    const nMatch = normReply.includes(normName) || normUser.includes(normName);

                    if (kMatch || cMatch || nMatch) {
                        console.log(`      ✅ MATCH FOUND for "${instName}"`);

                        // Check for specific image description matches
                        const specificMatches = images.filter(img => {
                            const normDesc = normalize(img.description);
                            // Check if description is present in user text or AI reply
                            return normDesc && normDesc.length > 1 && (normUser.includes(normDesc) || normReply.includes(normDesc));
                        });

                        if (specificMatches.length > 0) {
                            console.log(`      🎯 Specific description matches found: ${specificMatches.length}`);
                            specificMatches.forEach(img => {
                                imagesToSend.push({
                                    url: img.url,
                                    caption: img.description ? `📷 ${instName} - ${img.description}` : `📷 ${instName}`
                                });
                            });
                        } else {
                            // Fallback: Send all images if no specific description is mentioned
                            console.log(`      Running fallback: Sending all images for ${instName}`);
                            images.forEach(img => {
                                imagesToSend.push({
                                    url: img.url,
                                    caption: img.description ? `📷 ${instName} - ${img.description}` : `📷 ${instName}`
                                });
                            });
                        }
                        found = true;
                    }

                    if (!found) {
                        for (const img of images) {
                            const normDesc = normalize(img.description);
                            if (normDesc && normDesc.length > 1 && normReply.includes(normDesc)) {
                                console.log(`      ✅ MATCH FOUND via description: "${img.description}"`);
                                imagesToSend.push({ url: img.url, caption: `📷 ${instName} - ${img.description}` });
                                found = true;
                            }
                        }
                    }
                }

                if (imagesToSend.length === 0) {
                    const instsWithImages = instructions.filter(i => i.imageUrl);
                    if (instsWithImages.length === 1) {
                        const inst = instsWithImages[0];
                        console.log(`   ⚠️ FALLBACK: Sending images from "${inst.clientName}"`);
                        let images = [];
                        try {
                            if (inst.imageUrl.startsWith('[')) images = JSON.parse(inst.imageUrl);
                            else images = [{ url: inst.imageUrl }];
                        } catch (e) { images = [{ url: inst.imageUrl }]; }

                        images.forEach(img => {
                            imagesToSend.push({
                                url: img.url,
                                caption: img.description ? `📷 ${inst.clientName.trim()} - ${img.description}` : `📷 ${inst.clientName.trim()}`
                            });
                        });
                    }
                }

                if (imagesToSend.length > 0) {
                    const unique = [...new Map(imagesToSend.map(item => [item.url, item])).values()];
                    console.log(`🚀 RESULT: Sending ${unique.length} images.`);

                    for (const imgObj of unique) {
                        try {
                            const imagePath = path.join(process.cwd(), 'public', imgObj.url);
                            if (fs.existsSync(imagePath)) {
                                await sock.sendMessage(remoteJid, {
                                    image: { url: imagePath },
                                    caption: imgObj.caption
                                });
                                console.log(`   ✅ Sent: ${imgObj.url}`);
                            } else {
                                console.log(`   ❌ ERROR: File missing: ${imagePath}`);
                            }
                        } catch (err) {
                            console.error(`   ❌ FAIL: ${err.message}`);
                        }
                    }
                } else {
                    console.log("❌ RESULT: No matches found.");
                }
                console.log("--- [V6_SIGNATURE] IMAGE SCAN END ---\n");
            }

            // 5. Check if order is complete and send to group
            if (replyText.includes("تم إرسال طلبك بنجاح") && replyText.includes("رقم الطلب:")) {
                console.log("✅ Order completed! Preparing to forward to group...");
                await handleOrderCompletion(sock, remoteJid, text, replyText, userId);
            }
        }
    });

    return { status: 'started' };
};

export const stopSession = async (userId, io) => {
    // DISABLE Auto Reply in DB, but KEEP socket connection AND update status
    await User.update({ auto_reply: false, connection_status: 'paused' }, { where: { id: userId } });

    // Emit paused status
    if (io) io.to(`user_${userId}`).emit('status', { status: 'paused' });

    if (sessions.has(userId)) {
        return { status: 'paused', message: 'Bot Auto-Reply Paused' };
    }

    return { status: 'offline', message: 'Bot is offline' };
};

export const logoutSession = async (userId, io) => {
    console.log(`Logout requested for user ${userId}`);
    try {
        await User.update({ auto_reply: false, linked_phone_number: null, connection_status: 'not_registered' }, { where: { id: userId } });

        if (sessions.has(userId)) {
            const sock = sessions.get(userId);

            // Remove listeners to prevent auto-reconnect logic from firing
            sock.ev.removeAllListeners('connection.update');

            try {
                sock.end(undefined);
            } catch (e) {
                console.error("Error closing socket:", e);
            }
            sessions.delete(userId);
        }

        // Wait a bit to ensure file locks are released on Windows
        await new Promise(resolve => setTimeout(resolve, 1000));

        const authPath = path.join('sessions', `auth_info_${userId}`);
        if (fs.existsSync(authPath)) {
            try {
                fs.rmSync(authPath, { recursive: true, force: true });
            } catch (fsErr) {
                console.error(`Failed to delete session files for ${userId}:`, fsErr);
            }
        }

        if (io) io.to(`user_${userId}`).emit('status', { status: 'not_registered' });
        console.log(`User ${userId} logged out and session deleted.`);
        return { status: 'not_registered', message: 'Session Deleted' };
    } catch (error) {
        console.error("Logout Error:", error);
        return { status: 'error', message: error.message };
    }
};


export const restoreSessions = async (io) => {
    console.log("🔄 Restoring sessions...");
    try {
        const users = await User.findAll({ where: { auto_reply: true } });
        for (const user of users) {
            const authPath = path.join('sessions', `auth_info_${user.id}`);
            if (fs.existsSync(authPath)) {
                console.log(`♻️ Restoring session for user ${user.id}`);
                await startSession(user.id, io);
            } else {
                console.log(`⚠️ Session files missing for user ${user.id}, disabling auto_reply.`);
                user.auto_reply = false;
                user.connection_status = 'offline';
                await user.save();
            }
        }
    } catch (error) {
        console.error("❌ Error restoring sessions:", error);
    }
};

export const getStatus = async (userId) => {
    try {
        const user = await User.findByPk(userId);

        // 1. Check active session (Real-time connection)
        if (sessions.has(userId)) {
            const sock = sessions.get(userId);

            if (sock.user) {
                const id = sock.user.id.split(':')[0].split('@')[0];
                const name = sock.user.name || "My Bot";

                // Update DB just in case
                if (user.linked_phone_number !== id) {
                    await User.update({ linked_phone_number: id }, { where: { id: userId } });
                }

                // Check for Manual Pause (Highest Priority)
                if (user.connection_status === 'paused_manual') {
                    return { status: 'paused_manual', phone: id, name: name, pause_until: user.pause_until };
                }

                // If auto_reply is disabled, return PAUSED
                if (!user.auto_reply) {
                    return { status: 'paused', phone: id, name: name };
                }

                return { status: 'online', phone: id, name: name };
            }
            return { status: 'connecting' };
        }

        // 2. Check DB for previous connection (Offline but Registered)
        if (user && user.linked_phone_number) {
            // Return the stored status if available, else offline
            return {
                status: user.connection_status || 'offline',
                phone: user.linked_phone_number,
                pause_until: user.pause_until
            };
        }

        // 3. No session and no history (Not Registered)
        return { status: 'not_registered' };

    } catch (error) {
        console.error("Error checking user status:", error);
        return { status: 'offline' };
    }
};



export const getGroups = async (userId, page = 1, limit = 10) => {
    const sock = sessions.get(userId);
    if (!sock || !sock.user) {
        return [];
    }

    try {
        // 1. Fetch all groups metadata from Baileys (Cached)
        const groupsPromise = sock.groupFetchAllParticipating();
        // user timeout
        const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve({}), 3000));
        const result = await Promise.race([groupsPromise, timeoutPromise]);

        if (!result || Object.keys(result).length === 0) {
            return [];
        }

        let allGroups = Object.values(result);

        // 2. Fetch last activity time from DB for these groups
        // We want to sort by the most recent message sent/received in the group
        const groupJids = allGroups.map(g => g.id);

        const recentMessages = await Message.findAll({
            attributes: [
                'remoteJid',
                [Sequelize.fn('MAX', Sequelize.col('createdAt')), 'lastActivity']
            ],
            where: {
                remoteJid: {
                    [Op.in]: groupJids
                },
                UserId: userId
            },
            group: ['remoteJid'],
            raw: true
        });

        // Create a map for quick lookup: JID -> Timestamp
        const activityMap = new Map();
        recentMessages.forEach(msg => {
            activityMap.set(msg.remoteJid, new Date(msg.lastActivity).getTime());
        });

        // 3. Sort groups: Active first, then by Creation date
        allGroups.sort((a, b) => {
            const timeA = activityMap.get(a.id) || 0;
            const timeB = activityMap.get(b.id) || 0;

            if (timeA !== timeB) {
                return timeB - timeA; // Descending (newest activity first)
            }
            return (b.creation || 0) - (a.creation || 0); // Fallback to creation date
        });

        // 4. Pagination
        const startIndex = (page - 1) * limit;
        const endIndex = startIndex + limit;
        const paginatedGroups = allGroups.slice(startIndex, endIndex);

        return paginatedGroups.map(g => ({
            id: g.id,
            subject: g.subject
        }));

    } catch (error) {
        console.error("Error fetching groups:", error);
        return [];
    }
};

export const checkSubscriptionExpiry = async (io) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        console.log(`[Subscription Check] Checking for expired users before: ${today}`);

        const expiredUsers = await User.findAll({
            where: {
                is_active: true,
                expiry_date: {
                    [Op.ne]: null,
                    [Op.lt]: today
                },
                role: { [Op.ne]: 'super_admin' }
            }
        });

        if (expiredUsers.length > 0) {
            console.log(`[Subscription Check] Found ${expiredUsers.length} expired users.`);

            for (const user of expiredUsers) {
                console.log(`[Subscription Check] Suspending User: ${user.username} (ID: ${user.id})`);

                user.is_active = false;
                user.auto_reply = false;
                user.connection_status = 'paused';
                await user.save();

                // Emit status update to dashboard
                if (io) {
                    io.to(`user_${user.id}`).emit('status', { status: 'paused' });
                }

                try {
                    await stopSession(user.id, io);
                } catch (err) {
                    console.error(`[Subscription Check] Error stopping session for user ${user.id}:`, err);
                }
            }
        }
    } catch (error) {
        console.error("[Subscription Check] Error:", error);
    }
};

export const checkPauseTimer = async (io) => {
    try {
        const now = new Date();
        const pausedUsers = await User.findAll({
            where: {
                connection_status: 'paused_manual',
                pause_until: {
                    [Op.ne]: null,
                    [Op.lt]: now
                }
            }
        });

        if (pausedUsers.length > 0) {
            console.log(`[Pause Timer] Found ${pausedUsers.length} users to resume.`);

            for (const user of pausedUsers) {
                console.log(`[Pause Timer] Resuming User: ${user.username} (ID: ${user.id})`);

                user.connection_status = 'online';
                user.pause_until = null;
                await user.save();

                // Notify in Control Group if exists
                if (user.control_group_jid) {
                    try {
                        const sock = sessions.get(user.id);
                        if (sock) {
                            await sock.sendMessage(user.control_group_jid, { text: '✅ انتهت مدة الانتظار. تم استئناف الرد التلقائي.' });
                        }
                    } catch (err) {
                        console.error(`[Pause Timer] Error sending resume notification for user ${user.id}:`, err);
                    }
                }
            }
        }
    } catch (error) {
        console.error("[Pause Timer] Error:", error);
    }
};
