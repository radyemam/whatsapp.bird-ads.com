import express from 'express';
import {
    verifyWebhook,
    handleWebhook,
    getPages,
    connectPage,
    disconnectPage,
    getConversations,
    getSummary
} from '../controllers/messengerController.js';

const router = express.Router();

// ====== Webhook اللي بتتصل بيه ميتا ======
// GET: التحقق من الـ webhook (ميتا بتبعت طلب GET أول مرة)
router.get('/webhook/messenger', verifyWebhook);

// POST: استقبال الرسائل الجديدة
router.post('/webhook/messenger', handleWebhook);

// ====== صفحة إدارة الماسنجر في الداشبورد ======
router.get('/dashboard/messenger', (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');
    res.render('messenger', {
        user: req.user,
        page: 'messenger',
        webhookUrl: `${process.env.TUNNEL_URL || 'https://dull-rules-boil.loca.lt'}/webhook/messenger`,
        verifyToken: 'lina_messenger_verify_2024'
    });
});

// ====== API Routes للواجهة ======
// جلب الصفحات المربوطة
router.get('/api/messenger/pages', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false });
    return getPages(req, res);
});

// ربط صفحة جديدة
router.post('/api/messenger/connect', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false });
    return connectPage(req, res);
});

// حذف ربط صفحة
router.delete('/api/messenger/page/:pageId', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false });
    return disconnectPage(req, res);
});

// جلب المحادثات لصفحة معينة
router.get('/api/messenger/conversations/:pageId', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false });
    return getConversations(req, res);
});

// عمل ملخص لمحادثة
router.get('/api/messenger/summary/:conversationId', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false });
    return getSummary(req, res);
});

export default router;
