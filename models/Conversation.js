import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';
import User from './User.js';

const Conversation = sequelize.define('Conversation', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    remoteJid: {
        type: DataTypes.STRING,
        allowNull: false
    },
    platform: {
        type: DataTypes.STRING,
        defaultValue: 'whatsapp'
    },
    customerName: {
        type: DataTypes.STRING,
        allowNull: true
    },
    is_handoff: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
    },
    unreadCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    lastMessageText: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    lastMessageAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
    }
}, {
    tableName: 'conversations',
    indexes: [
        {
            unique: true,
            fields: ['UserId', 'remoteJid']
        }
    ]
});

// Relationships
User.hasMany(Conversation, { onDelete: 'CASCADE' });
Conversation.belongsTo(User);

export default Conversation;
