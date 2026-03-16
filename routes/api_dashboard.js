
import express from 'express';
import { startSession, stopSession, logoutSession, getStatus, getGroups } from '../controllers/botController.js';

const router = express.Router();

// Middleware to simulate authentication via userId passed in body/query
// In a real production app, this should be secured with a generated API Key or JWT.
// For this local MVP, we trust the dashboard to send the correct ID.

router.get('/status/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const statusResult = await getStatus(userId);
        res.json(statusResult);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch status' });
    }
});

router.post('/start', async (req, res) => {
    try {
        const { userId } = req.body;
        const io = req.app.get('socketio');
        const result = await startSession(userId, io);
        res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to start bot' });
    }
});

router.post('/pair', async (req, res) => {
    try {
        const { userId, phoneNumber } = req.body;
        const io = req.app.get('socketio');
        const result = await startSession(userId, io, phoneNumber);
        res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to pair bot' });
    }
});

router.post('/stop', async (req, res) => {
    try {
        const { userId } = req.body;
        const io = req.app.get('socketio');
        const result = await stopSession(userId, io);
        res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to stop bot' });
    }
});

router.post('/logout', async (req, res) => {
    try {
        const { userId } = req.body;
        const io = req.app.get('socketio');
        const result = await logoutSession(userId, io);
        res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to logout bot' });
    }
});

export default router;
