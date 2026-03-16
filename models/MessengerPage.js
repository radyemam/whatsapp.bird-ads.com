import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

const MessengerPage = sequelize.define('MessengerPage', {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    UserId: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    pageName: {
        type: DataTypes.STRING,
        allowNull: false
    },
    pageId: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
    },
    accessToken: {
        type: DataTypes.TEXT,
        allowNull: false
    },
    isActive: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    },
    // الـ verify token بتاعنا اللي بنحطه في ميتا
    webhookVerifyToken: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'lina_messenger_verify_2024'
    }
}, {
    tableName: 'messenger_pages'
});

export default MessengerPage;
