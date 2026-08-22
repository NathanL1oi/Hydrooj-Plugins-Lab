#!/usr/bin/env node

// 初始化所有用户rating为1000的脚本
const { MongoClient } = require('mongodb');

async function initializeAllRatings() {
    const mongoUrl = process.env.MONGO_URL || 'mongodb://localhost:27017/hydro';
    const client = new MongoClient(mongoUrl);
    
    try {
        await client.connect();
        console.log('Connected to MongoDB');
        
        const db = client.db();
        const ratingColl = db.collection('rating');
        const ratingHistoryColl = db.collection('ratingHistory');
        const userColl = db.collection('user');
        
        // 获取所有用户
        const users = await userColl.find({}).toArray();
        console.log(`Found ${users.length} users`);
        
        let initializedCount = 0;
        
        for (const user of users) {
            const uid = user._id;
            
            // 删除现有的rating记录
            await ratingColl.deleteMany({ uid });
            await ratingHistoryColl.deleteMany({ uid });
            
            // 创建新的rating记录
            await ratingColl.insertOne({
                uid,
                rating: 1000,
                maxRating: 1000,
                contestCount: 0,
                lastUpdate: new Date()
            });
            
            initializedCount++;
            
            if (initializedCount % 100 === 0) {
                console.log(`Initialized ${initializedCount}/${users.length} users`);
            }
        }
        
        console.log(`Successfully initialized ${initializedCount} users with rating 1000`);
        
    } catch (error) {
        console.error('Error initializing ratings:', error);
    } finally {
        await client.close();
    }
}

// 运行脚本
if (require.main === module) {
    initializeAllRatings().then(() => {
        console.log('Script completed');
        process.exit(0);
    }).catch(error => {
        console.error('Script failed:', error);
        process.exit(1);
    });
}

module.exports = { initializeAllRatings };