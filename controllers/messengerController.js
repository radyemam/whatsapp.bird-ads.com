import fetch from 'node-fetch';
import { CONFIG } from '../config.js';
import User from '../models/User.js';
import Instruction from '../models/Instruction.js';
import MessengerPage from '../models/MessengerPage.js';
import MessengerConversation from '../models/MessengerConversation.js';
import Message from '../models/Message.js';
import { GoogleAuth } from 'google-auth-library';

// الـ Verify Token اللي بنستخدمه مع ميتا
const VERIFY_TOKEN = 'lina_messenger_verify_2024';

// ======================================================
// دالة للتحقق من الـ Webhook اللي بتطلبها ميتا (GET)
// ======================================================
export function verifyWebhook(req, res) {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('✅ [Messenger] Webhook verified successfully!');
        res.status(200).send(challenge);
    } else {
        console.error('❌ [Messenger] Webhook verification failed!');
        res.sendStatus(403);
    }
}

// ======================================================
// دالة لاستقبال الرسائل القادمة من ميتا (POST)
// ======================================================
export async function handleWebhook(req, res) {
    // دايماً نبعت 200 فوراً عشان ميتا ما تعيد المحاولة
    res.sendStatus(200);

    const body = req.body;
    console.log('📨 [Messenger Webhook] Received event:', JSON.stringify(body).substring(0, 300));

    if (body.object !== 'page') {
        console.log('⚠️ [Messenger Webhook] Not a page event, ignoring.');
        return;
    }

    for (const entry of body.entry) {
        const pageId = entry.id;
        console.log(`📌 [Messenger] Entry from page: ${pageId}`);

        for (const event of entry.messaging) {
            // تجاهل الـ echo (الرسائل اللي بعتها البوت نفسه)
            if (event.message?.is_echo) continue;
            // تجاهل الـ read و delivery events
            if (!event.message?.text) continue;

            const senderId = event.sender.id;
            const messageText = event.message.text;
            console.log(`💬 [Messenger] Message from ${senderId}: "${messageText}"`);

            try {
                await processMessengerMessage(pageId, senderId, messageText);
            } catch (err) {
                console.error(`[Messenger] Error processing message from ${senderId}:`, err);
            }
        }
    }
}

// ======================================================
// الدالة الرئيسية لمعالجة الرسائل والرد عليها بالـ AI
// ======================================================
async function processMessengerMessage(pageId, senderId, messageText) {
    // 1. جيب بيانات الصفحة من قاعدة البيانات
    const page = await MessengerPage.findOne({ where: { pageId, isActive: true } });
    if (!page) {
        console.warn(`[Messenger] No active page found for pageId: ${pageId}`);
        return;
    }

    const userId = page.UserId;
    const accessToken = page.accessToken;

    // 2. اعمل أو حدّث بيانات الـ conversation
    let [conversation, created] = await MessengerConversation.findOrCreate({
        where: { pageId, senderId },
        defaults: { UserId: userId, pageId, senderId, messageCount: 0 }
    });

    // 3. جيب اسم المرسل من ميتا (لو مجبناهوش قبل كده)
    if (created || conversation.senderName === 'عميل') {
        try {
            const profileRes = await fetch(`https://graph.facebook.com/v18.0/${senderId}?fields=name&access_token=${accessToken}`);
            const profileData = await profileRes.json();
            if (profileData.name) {
                await conversation.update({ senderName: profileData.name });
            }
        } catch (e) {
            // لو مش قادر يجيب الاسم، مش مشكلة
        }
    }

    // 4. حدّث عدد الرسائل وتاريخ آخر رسالة
    await conversation.update({
        messageCount: conversation.messageCount + 1,
        lastMessageAt: new Date()
    });

    // 5. احفظ الرسالة في جدول الرسائل
    const conversationId = `msng_${pageId}_${senderId}`;
    await Message.create({
        UserId: userId,
        remoteJid: conversationId,
        role: 'user',
        content: messageText
    });

    // 6. استدعي الـ AI للرد
    const aiReply = await callVertexAIForMessenger(userId, senderId, messageText, conversationId);

    if (aiReply) {
        // 7. احفظ رد الـ AI
        await Message.create({
            UserId: userId,
            remoteJid: conversationId,
            role: 'model', // Fixed from 'assistant' to 'model'
            content: aiReply
        });

        // 8. ابعت الرد للعميل على الماسنجر
        await sendMessengerReply(senderId, aiReply, accessToken);
    }
}

// ======================================================
// استدعاء Vertex AI خصيصاً للماسنجر
// ======================================================
async function callVertexAIForMessenger(userId, senderId, userText, conversationId) {
    try {
        // جيب التعليمات المفعّلة لهذا المستخدم
        const allInstructions = await Instruction.findAll({
            where: { UserId: userId, isActive: true },
            order: [['order', 'ASC'], ['createdAt', 'DESC']]
        });

        const normalizeText = (text) => text ? text.toLowerCase().trim() : "";
        const userQuery = normalizeText(userText);

        // فلتر التعليمات بنفس منطق الواتساب
        let filteredInstructions = allInstructions.filter(inst => {
            if (inst.type === 'global') return true;
            if (inst.keywords) {
                const keywords = inst.keywords.split(',').map(k => normalizeText(k));
                return keywords.some(k => k.length > 2 && userQuery.includes(k));
            }
            return false;
        });

        // لو مافيش تعليمات مفلترة، خذ global فقط
        if (filteredInstructions.length === 0) {
            filteredInstructions = allInstructions.filter(inst => inst.type === 'global');
        }

        // ابني الـ system prompt
        const systemInstructions = filteredInstructions.map(inst => inst.content).join('\n\n---\n\n');

        // جيب آخر 10 رسائل كـ context
        const historySaved = await Message.findAll({
            where: { UserId: userId, remoteJid: conversationId },
            order: [['createdAt', 'DESC']],
            limit: 10
        });
        const history = historySaved.reverse();

        const historyText = history.map(msg =>
            `${msg.role === 'user' ? 'العميل' : 'المساعد'}: ${msg.content}`
        ).join('\n');

        const prompt = `${systemInstructions}\n\nسياق المحادثة السابقة:\n${historyText}\n\nالعميل: ${userText}\nالمساعد:`;

        // Vertex AI URL (uses Service Account authentication)
        const location = 'us-central1';
        const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${CONFIG.PROJECT_ID}/locations/${location}/publishers/google/models/${CONFIG.MODEL_NAME}:generateContent`;

        const payload = {
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.7,
                topK: 40,
                topP: 0.95,
                maxOutputTokens: 1024,
            }
        };

        // Initialize auth with Service Account credentials
        const auth = new GoogleAuth({
            keyFilename: CONFIG.GOOGLE_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS || 'trim-bot-486500-h8-4b614b18f7c0.json',
            scopes: ['https://www.googleapis.com/auth/cloud-platform']
        });

        const client = await auth.getClient();
        const accessToken = await client.getAccessToken();

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken.token}`
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Vertex API Error: ${response.status} ${errText}`);
        }

        const data = await response.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || null;

    } catch (err) {
        console.error('[Messenger] Vertex AI Error:', err);
        return 'عذراً، حدث خطأ مؤقت. يرجى المحاولة مرة أخرى.';
    }
}

// ======================================================
// إرسال رد للماسنجر عبر Graph API
// ======================================================
async function sendMessengerReply(recipientId, text, accessToken) {
    try {
        const response = await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${accessToken}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                recipient: { id: recipientId },
                message: { text: text.substring(0, 2000) } // ميتا بتحد الرسالة بـ 2000 حرف
            })
        });

        const data = await response.json();
        if (data.error) {
            console.error('[Messenger] Send Error:', data.error);
        } else {
            console.log(`✅ [Messenger] Reply sent to ${recipientId}`);
        }
    } catch (err) {
        console.error('[Messenger] Failed to send reply:', err);
    }
}

// ======================================================
// عمل ملخص للمحادثة بالـ AI
// ======================================================
export async function generateConversationSummary(userId, conversationId) {
    try {
        const messages = await Message.findAll({
            where: { UserId: userId, remoteJid: conversationId },
            order: [['createdAt', 'ASC']]
        });

        if (messages.length === 0) return null;

        const conversationText = messages.map(msg =>
            `${msg.role === 'user' ? 'العميل' : 'البوت'}: ${msg.content}`
        ).join('\n');

        const location = 'us-central1';
        const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${CONFIG.PROJECT_ID}/locations/${location}/publishers/google/models/${CONFIG.MODEL_NAME}:generateContent`;

        const auth = new GoogleAuth({
            keyFilename: CONFIG.GOOGLE_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS || 'trim-bot-486500-h8-4b614b18f7c0.json',
            scopes: ['https://www.googleapis.com/auth/cloud-platform']
        });

        const client = await auth.getClient();
        const accessToken = await client.getAccessToken();

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken.token}`
            },
            body: JSON.stringify({
                contents: [{
                    role: "user",
                    parts: [{
                        text: `اعمل ملخص قصير (3-5 أسطر) لهذه المحادثة مع العميل، اذكر ما طلبه العميل وكيف تم الرد:
${conversationText}`
                    }]
                }],
                generationConfig: { temperature: 0.3, maxOutputTokens: 300 }
            })
        });

        const data = await response.json();
        const summary = data.candidates?.[0]?.content?.parts?.[0]?.text || null;

        // احفظ الملخص في قاعدة البيانات
        if (summary) {
            const convId = conversationId.split('_').slice(2).join('_'); // senderId
            await MessengerConversation.update(
                { summary },
                { where: { senderId: convId } }
            );
        }

        return summary;
    } catch (err) {
        console.error('[Messenger] Summary Error:', err);
        return null;
    }
}

// ======================================================
// API Routes للداشبورد
// ======================================================

// جلب كل الصفحات المربوطة للمستخدم
export async function getPages(req, res) {
    try {
        const pages = await MessengerPage.findAll({ where: { UserId: req.user.id } });
        res.json({ success: true, pages });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
}

// ربط صفحة جديدة
export async function connectPage(req, res) {
    try {
        const { pageId, pageName, accessToken } = req.body;
        if (!pageId || !pageName || !accessToken) {
            return res.status(400).json({ success: false, message: 'جميع الحقول مطلوبة' });
        }

        const [page, created] = await MessengerPage.findOrCreate({
            where: { pageId },
            defaults: { UserId: req.user.id, pageName, pageId, accessToken, isActive: true }
        });

        if (!created) {
            // لو موجودة قبل كده، حدّثها
            await page.update({ pageName, accessToken, isActive: true });
        }

        res.json({ success: true, message: `تم ربط صفحة "${pageName}" بنجاح!`, page });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
}

// حذف ربط صفحة
export async function disconnectPage(req, res) {
    try {
        const { pageId } = req.params;
        await MessengerPage.destroy({ where: { pageId, UserId: req.user.id } });
        res.json({ success: true, message: 'تم إلغاء ربط الصفحة' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
}

// جلب المحادثات لصفحة معينة
export async function getConversations(req, res) {
    try {
        const { pageId } = req.params;
        const conversations = await MessengerConversation.findAll({
            where: { pageId, UserId: req.user.id },
            order: [['lastMessageAt', 'DESC']],
            limit: 50
        });
        res.json({ success: true, conversations });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
}

// جيب محادثة وعمل ملخص لها
export async function getSummary(req, res) {
    try {
        const { conversationId } = req.params;
        const summary = await generateConversationSummary(req.user.id, conversationId);
        res.json({ success: true, summary });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
}
