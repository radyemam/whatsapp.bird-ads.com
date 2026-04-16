import express from 'express';
import { startSession, stopSession, logoutSession, getStatus, getGroups } from '../controllers/botController.js';
import User from '../models/User.js';
import Message from '../models/Message.js';
import Instruction from '../models/Instruction.js';
import { upload, compressAndSaveImage, deleteImage } from '../config/uploadConfig.js';

const router = express.Router();

// Middleware to ensure login
const isAuthenticated = (req, res, next) => {
    if (req.isAuthenticated()) return next();
    res.redirect('/login');
};

router.use(isAuthenticated);

router.get('/', async (req, res) => {
    if (req.user.role === 'super_admin') {
        return res.redirect('/admin');
    }
    const statusResult = await getStatus(req.user.id);
    res.render('user_dashboard', {
        user: req.user,
        status: statusResult.status || 'offline',
        phone: statusResult.phone || '',
        page: 'home'
    });
});

router.get('/chats', async (req, res) => {
    try {
        // Fetch unique contacts
        const contacts = await Message.findAll({
            where: { UserId: req.user.id },
            attributes: ['remoteJid'],
            group: ['remoteJid']
        });

        // Fetch requested chat messages if 'jid' query is present
        let messages = [];
        let activeJid = req.query.jid || null;

        if (activeJid) {
            messages = await Message.findAll({
                where: { UserId: req.user.id, remoteJid: activeJid },
                order: [['createdAt', 'ASC']]
            });
        }

        res.render('chats', { user: req.user, page: 'chats', contacts, messages, activeJid });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error fetching chats");
    }
});

router.post('/start-bot', async (req, res) => {
    const io = req.app.get('socketio');
    const result = await startSession(req.user.id, io);
    res.json(result);
});

router.post('/pair-bot', async (req, res) => {
    const { phoneNumber } = req.body;
    const io = req.app.get('socketio');
    const result = await startSession(req.user.id, io, phoneNumber);
    res.json(result);
});

router.post('/stop-bot', async (req, res) => {
    const io = req.app.get('socketio');
    const result = await stopSession(req.user.id, io);
    res.json(result);
});

router.post('/logout-bot', async (req, res) => {
    const io = req.app.get('socketio');
    const result = await logoutSession(req.user.id, io);
    res.json(result);
});

router.get('/groups', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const groups = await getGroups(req.user.id, page);
        res.json(groups);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch groups' });
    }
});

// Instructions CRUD
router.get('/instructions', async (req, res) => {
    try {
        const instructions = await Instruction.findAll({
            where: { UserId: req.user.id },
            order: [['order', 'ASC'], ['createdAt', 'DESC']]
        });

        // Groups fetch removed to prevent hanging. Groups can be loaded via AJAX if needed.
        const groups = [];
        res.render('instructions', { user: req.user, page: 'instructions', instructions, groups, success: false });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error fetching instructions");
    }
});

import { analyzeAndSegmentText, generateKeywords } from '../controllers/aiController.js';
import SimulationMessage from '../models/SimulationMessage.js';
import TeachMessage from '../models/TeachMessage.js';
import { simulateChat, teachBot } from '../controllers/botController.js';

router.post('/instructions/add', async (req, res) => {
    try {
        const { clientName, title, content, actionTarget, imageUrl } = req.body;

        // Debug logging
        console.log("📝 Received instruction data:", { clientName, title, content: content?.substring(0, 50), actionTarget, imageUrl });

        // Try AI Analysis, but fallback to direct creation if it fails
        try {
            console.log("🧠 Analyzing instruction text...");
            const segments = await analyzeAndSegmentText(content);

            if (segments && segments.length > 0) {
                console.log(`✅ AI Segmentation Result: ${segments.length} segments.`);

                for (let i = 0; i < segments.length; i++) {
                    const segment = segments[i];
                    await Instruction.create({
                        clientName: segment.clientName || clientName,
                        title: segment.title || title,
                        content: segment.content,
                        actionTarget: actionTarget,
                        imageUrl: i === 0 ? imageUrl : '', // Attach images only to first segment
                        UserId: req.user.id,
                        keywords: segment.keywords,
                        type: segment.type || 'topic'
                    });
                }
            } else {
                throw new Error("No segments returned from AI");
            }
        } catch (aiError) {
            console.log("⚠️ AI segmentation failed, creating instruction directly:", aiError.message);

            // Fallback: Create instruction directly with basic keyword generation
            let keywords = null;
            try {
                keywords = await generateKeywords(content);
            } catch (kwError) {
                console.log("⚠️ Keyword generation also failed, setting to null");
            }

            await Instruction.create({
                clientName,
                title,
                content,
                actionTarget,
                imageUrl,
                UserId: req.user.id,
                keywords: keywords,
                type: 'topic'
            });
        }

        res.redirect('/dashboard/instructions');
    } catch (err) {
        console.error(err);
        res.status(500).send("Error adding instruction");
    }
});


router.post('/instructions/edit/:id', async (req, res) => {
    try {
        const { clientName, title, content, actionTarget, imageUrl, keywords } = req.body;

        await Instruction.update({
            clientName, title, content, actionTarget, imageUrl,
            keywords: keywords || '' // Only save the exact edited keywords
        }, { where: { id: req.params.id } });

        res.redirect('/dashboard/instructions');
    } catch (err) {
        console.error(err);
        res.status(500).send("Error updating instruction");
    }
});

// Alternative route for edit (accepts ID from body instead of URL)
router.post('/instructions/edit', async (req, res) => {
    try {
        const { id, clientName, title, content, actionTarget, imageUrl, keywords } = req.body;

        await Instruction.update({
            clientName, title, content, actionTarget, imageUrl,
            keywords: keywords || '' // Only save the exact edited keywords
        }, { where: { id: id } });

        res.redirect('/dashboard/instructions');
    } catch (err) {
        console.error(err);
        res.status(500).send("Error updating instruction");
    }
});


// [RESTORED] Missing Routes
router.post('/instructions/toggle/:id', async (req, res) => {
    try {
        const instruction = await Instruction.findOne({ where: { id: req.params.id } });
        if (instruction) {
            instruction.isActive = !instruction.isActive;
            await instruction.save();
        }
        res.redirect('/dashboard/instructions');
    } catch (err) { res.status(500).send("Error"); }
});

router.post('/instructions/delete', async (req, res) => {
    try {
        await Instruction.destroy({ where: { id: req.body.id } });
        res.redirect('/dashboard/instructions');
    } catch (err) { res.status(500).send("Error"); }
});

router.post('/instructions/delete-multiple', async (req, res) => {
    try {
        const { ids, action } = req.body;
        if (action === 'all') {
            await Instruction.destroy({ where: { UserId: req.user.id } });
        } else if (ids && Array.isArray(ids)) {
            await Instruction.destroy({ where: { id: ids, UserId: req.user.id } });
        }
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to delete instructions" });
    }
});

router.post('/chats/delete', async (req, res) => {
    try {
        const { remoteJid } = req.body;
        await Message.destroy({
            where: {
                remoteJid,
                UserId: req.user.id
            }
        });
        res.redirect('/dashboard/chats');
    } catch (err) {
        console.error(err);
        res.status(500).send("Error deleting chat");
    }
});

// ============================================
// Training / Simulator Routes (المرحلة الثالثة)
// ============================================

router.post('/training/setup-wizard', async (req, res) => {
    try {
        const { botName, businessType, firstServiceName, serviceDetails, serviceImageUrl, items } = req.body;
        
        // Handle Identity (if botName provided)
        if (botName) {
            const identityContent = `أنت موظف خدمة العملاء ومسؤول المبيعات. اسمك هو ${botName}. مهمتك مساعدة العملاء والإجابة على استفساراتهم باحترافية واحترام وود.`;
            
            // Check if identity exists
            let identityInst = await Instruction.findOne({ where: { UserId: req.user.id, type: 'global' } });
            if (identityInst) {
                identityInst.content = identityContent;
                identityInst.keywords = 'اسمك ايه, انت مين, وظيفتك, مين معايا';
                await identityInst.save();
            } else {
                await Instruction.create({
                    clientName: 'إعدادات عامة',
                    title: 'هوية البوت واسمه',
                    content: identityContent,
                    actionTarget: '',
                    imageUrl: '',
                    UserId: req.user.id,
                    keywords: 'اسمك ايه, انت مين, وظيفتك, مين معايا',
                    type: 'global'
                });
            }
        }

        // Process dynamic items list
        if (items && Array.isArray(items)) {
            for (const item of items) {
                if (item.name && item.details) {
                    const isService = item.type === 'خدمة';
                    const isProduct = item.type === 'منتج';
                    let serviceContent = '';
                    
                    if (isService) {
                        serviceContent = `نحن نقدم خدمة: ${item.name}.\nتفاصيل الخدمة والاستفادة منها: ${item.details}`;
                    } else if (isProduct) {
                        serviceContent = `نوفر لك المنتج الرائع: ${item.name}.\nالمواصفات والسعر: ${item.details}`;
                    } else {
                        serviceContent = `${item.name}: ${item.details}`;
                    }

                    let keywordsStr = `${item.name}, السعر, بكام, تفاصيل, معلومات عن`;
                    if (isProduct) keywordsStr += `, مقاس, الوان, متاح`;
                    else if (isService) keywordsStr += `, حجز, موعد, ميعاد`;

                    await Instruction.create({
                        clientName: isService ? 'الخدمات' : (isProduct ? 'المنتجات' : 'أخرى'),
                        title: item.name,
                        content: serviceContent,
                        actionTarget: '',
                        imageUrl: item.image || '',
                        UserId: req.user.id,
                        keywords: keywordsStr,
                        type: 'topic'
                    });
                }
            }
        }

        res.json({ success: true, message: 'تم حفظ الإعدادات بنجاح!' });
    } catch (err) {
        console.error("Setup Wizard Error:", err);
        res.status(500).json({ error: "Mission failed. Please try again." });
    }
});

router.get('/training', async (req, res) => {
    try {
        const messages = await SimulationMessage.findAll({
            where: { UserId: req.user.id },
            order: [['createdAt', 'ASC']]
        });
        
        const teachMessages = await TeachMessage.findAll({
            where: { UserId: req.user.id },
            order: [['createdAt', 'ASC']]
        });

        // Count tokens
        const user = await User.findByPk(req.user.id);
        const tokensUsed = user.total_tokens || 0;

        // ======================================================
        // 📚 المقترح 2 و 3: جلب التعليمات لعرض ID و Keywords
        // ======================================================
        const instructions = await Instruction.findAll({
            where: { UserId: req.user.id },
            order: [['order', 'ASC'], ['createdAt', 'DESC']],
            attributes: ['id', 'clientName', 'title', 'keywords', 'type', 'isActive', 'createdAt']
        });

        res.render('training', { 
            user: req.user, 
            page: 'training',
            messages,
            teachMessages,
            tokensUsed,
            instructions
        });
    } catch (err) {
        console.error("Training page error:", err);
        res.status(500).send("Error loading training page");
    }
});


router.post('/training/send', async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) return res.status(400).json({ error: "Message is required" });

        // Save User Message to Training DB
        const savedMessage = await SimulationMessage.create({
            role: 'user',
            content: message,
            UserId: req.user.id
        });

        // Get AI Reply
        const aiReply = await simulateChat(req.user.id, message);

        // Save AI Reply to Training DB
        let aiSavedMessage = null;
        if (aiReply) {
            aiSavedMessage = await SimulationMessage.create({
                role: 'model',
                content: aiReply,
                UserId: req.user.id
            });
        }

        res.json({ success: true, aiReply: aiSavedMessage });
    } catch (err) {
        console.error("Training send error:", err);
        res.status(500).json({ error: "Failed to send message" });
    }
});

router.post('/training/clear', async (req, res) => {
    try {
        await SimulationMessage.destroy({
            where: { UserId: req.user.id }
        });
        res.json({ success: true });
    } catch (err) {
        console.error("Training clear error:", err);
        res.status(500).json({ error: "Failed to clear chat" });
    }
});

// Teach Bot Routes
router.post('/training/teach', async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) return res.status(400).json({ error: "Message is required" });

        await TeachMessage.create({ role: 'user', content: message, UserId: req.user.id });

        const aiReply = await teachBot(req.user.id, message);

        let aiSavedMessage = null;
        if (aiReply) {
            aiSavedMessage = await TeachMessage.create({ role: 'model', content: aiReply, UserId: req.user.id });
        }

        res.json({ success: true, aiReply: aiSavedMessage });
    } catch (err) {
        console.error("Teach send error:", err);
        res.status(500).json({ error: "Failed to send message" });
    }
});

router.post('/training/clear-teach', async (req, res) => {
    try {
        await TeachMessage.destroy({ where: { UserId: req.user.id } });
        res.json({ success: true });
    } catch (err) {
        console.error("Teach clear error:", err);
        res.status(500).json({ error: "Failed to clear chat" });
    }
});

// Profile Routes
router.get('/profile', (req, res) => {
    res.render('profile', { user: req.user, page: 'profile' });
});

router.post('/profile/password', async (req, res) => {
    try {
        const { currentPassword, newPassword, confirmPassword } = req.body;

        if (newPassword !== confirmPassword) {
            return res.render('profile', { user: req.user, page: 'profile', error: 'كلمة المرور الجديدة غير متطابقة!' });
        }

        const user = await User.findByPk(req.user.id);
        const isValid = await user.validPassword(currentPassword);

        if (!isValid) {
            return res.render('profile', { user: req.user, page: 'profile', error: 'كلمة المرور الحالية غير صحيحة!' });
        }

        user.password = newPassword;
        await user.save(); // Hooks will hash it

        res.render('profile', { user: req.user, page: 'profile', success: true });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error updating password");
    }
});


// Privacy Policy Route
router.get('/privacy', (req, res) => {
    res.render('privacy_policy', { user: req.user, page: 'privacy' });
});

// Image Upload Routes
router.post('/instructions/upload-image', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No image uploaded' });
        }

        // Compress and save image
        const imageUrl = await compressAndSaveImage(req.file);

        res.json({ imageUrl });
    } catch (err) {
        console.error('Upload error:', err);
        res.status(500).json({ error: 'Failed to upload image' });
    }
});

router.post('/instructions/delete-image', async (req, res) => {
    try {
        const { imageUrl } = req.body;
        deleteImage(imageUrl);
        res.json({ success: true });
    } catch (err) {
        console.error('Delete error:', err);
        res.status(500).json({ error: 'Failed to delete image' });
    }
});

export default router;
