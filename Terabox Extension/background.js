const keepAlive = (() => {
    let interval = null;
    return (state) => {
        if (state && !interval) {
            interval = setInterval(chrome.runtime.getPlatformInfo, 20e3);
            if (performance.now() > 20e3) {
                chrome.runtime.getPlatformInfo();
            }
        } else if (!state && interval) {
            clearInterval(interval);
            interval = null;
        }
    };
})();

let isRunning = false;
let logs = [];
let teraboxSubdomain = '';
let dailyLimitReached = false;
let coins = 0;
let baseGemMergeDelay = 300;
let maxGemMergeDelay = 30000; // Increased max delay to 30 seconds
let currentGemMergeDelay = baseGemMergeDelay;
let consecutiveTimeouts = 0;
let lastTimeoutTime = 0;
let successfulRequestsCount = 0;
let timeoutPattern = [];

let globalLogCount = 0
function addLog(message) {
    const timestamp = new Date().toLocaleTimeString();
    globalLogCount++
    logs.push(`${globalLogCount} : [${timestamp}] ${message}`);
    if (logs.length > 100) {
        logs.shift();
    }
    chrome.runtime.sendMessage({action: 'logUpdated'}).catch(console.error);
}

chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.set({ isRunning: false, dailyLimitReached: false }).catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
    keepAlive(true);
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {
        case 'startCollecting':
            if (!isRunning && !dailyLimitReached) {
                isRunning = true;
                addLog('Started coin collection process');
                checkRedirect().then((subdomain) => {
                    teraboxSubdomain = subdomain;
                    collectCoins();
                });
                sendResponse({ success: true });
            } else {
                sendResponse({ success: false, message: dailyLimitReached ? 'Daily limit reached' : 'Already running' });
            }
            break;
        case 'stopCollecting':
            isRunning = false;
            addLog('Stopped coin collection process');
            sendResponse({ success: true });
            break;
        case 'getStatus':
            sendResponse({ isRunning: isRunning, dailyLimitReached: dailyLimitReached });
            break;
        case 'getLogs':
            sendResponse(logs);
            break;
        case 'getUserInfoAndCoinCount':
            getUserInfoAndCoinCount()
                .then(data => sendResponse(data))
                .catch(error => sendResponse({error: error.message}));
            return true;
        case 'loadEmbeddedPage':
            loadEmbeddedPage(request.url, sender.tab.id);
            break;
    }
    return true;
});

async function loadEmbeddedPage(url, tabId) {
    try {
        const response = await fetch(url, { credentials: 'include' });
        const text = await response.text();
        
        chrome.tabs.sendMessage(tabId, {
            action: 'updateEmbeddedContent',
            content: text
        });
    } catch (error) {
        console.error('Error loading embedded content:', error);
        chrome.tabs.sendMessage(tabId, {
            action: 'updateEmbeddedContent',
            content: 'Error loading content. Please try again.'
        });
    }
}

chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [{
        id: 1,
        priority: 1,
        action: {
            type: 'modifyHeaders',
            responseHeaders: [
                { header: 'X-Frame-Options', operation: 'remove' },
                { header: 'Frame-Options', operation: 'remove' }
            ]
        },
        condition: {
            urlFilter: '*://*.terabox.com/*',
            resourceTypes: ['sub_frame']
        }
    }]
});

async function getTeraboxCookies() {
    return new Promise((resolve) => {
        chrome.cookies.getAll({ domain: 'terabox.com' }, (cookies) => {
            resolve(cookies);
        });
    });
}

async function checkRedirect() {
    try {
        const cookies = await getTeraboxCookies();
        const cookieString = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');

        const response = await fetch('https://www.terabox.com', { 
            method: 'GET',
            redirect: 'follow',
            credentials: 'include',
            headers: {
                'Cookie': cookieString
            }
        });
        
        const finalUrl = response.url;
        const url = new URL(finalUrl);
        teraboxSubdomain = url.hostname.split('.')[0];
        addLog(`Redirected to: ${finalUrl}`);
        addLog(`Using subdomain: ${teraboxSubdomain}`);

        return teraboxSubdomain;
    } catch (error) {
        addLog(`Error checking redirect: ${error.message}`);
        return '';
    }
}

async function collectCoins() {
    try {
        keepAlive(true);
        
        // Get extra 80 bonus coins first
        addLog('Requesting bonus coins...');
        const bonusResponse = await fetchWithRetry(getTeraboxUrl('/rest/1.0/imact/goldrain/report?&valid_envelope_cnt=80'));
        if (bonusResponse.errno === 0) {
            addLog('Successfully collected bonus coins');
        }

        // Main game loop
        while (isRunning) {
            try {
                addLog('Starting GemMerge game...');
                await playGemMergeGame();
                
                addLog('Game cycle completed');
                
                // Update coin count in UI
                chrome.runtime.sendMessage({ action: 'updateCoinCount' }).catch(console.error);

                // Random delay between cycles (5-10 seconds)
                const nextCycleDelay = 5000 + Math.random() * 5000;
                addLog(`Waiting ${Math.round(nextCycleDelay / 1000)} seconds before next cycle...`);
                await delay(nextCycleDelay);

            } catch (error) {
                addLog(`Error during games cycle: ${error.message}`);
                await delay(10000); // Wait 10 seconds before retrying if error occurs
            }
        }
    } finally {
        keepAlive(false);
    }
}
    

async function playGemMergeGame() {
    // Reset delay management stats at start of game
    currentGemMergeDelay = baseGemMergeDelay;
    consecutiveTimeouts = 0;
    successfulRequestsCount = 0;
    timeoutPattern = [];
    lastTimeoutTime = 0;
    
    try {
        // Try to retrieve stored game state
        const gameState = await new Promise(resolve => {
            chrome.storage.local.get(['gemMergeState'], result => {
                resolve(result.gemMergeState || null);
            });
        });

        let gameId;
        let currentLevel;

        // Check if we have a stored game and if it's still valid
        if (gameState) {
            addLog('Attempting to resume previous game session...');
            
            // Verify the stored game is still valid
            const userData = await fetchWithRetry(getTeraboxUrl('/mergegame/getUserData'), {
                method: 'POST',
                body: JSON.stringify({"snsid": "game2"})
            });

            await adaptiveDelay();

            if (userData.data?.gameid === gameState.gameId) {
                gameId = gameState.gameId;
                currentLevel = gameState.level;
                addLog(`Resumed game ID: ${gameId} at level ${currentLevel}`);
            } else {
                addLog('Stored game is no longer valid, starting new game...');
                gameId = null;
                currentLevel = 2;
            }
        } else {
            currentLevel = 2;
        }

        // Start new game if we don't have a valid stored game
        if (!gameId) {
            currentLevel = 2;
            let gameResponse;
            try {
                gameResponse = await fetchWithRetry(getTeraboxUrl('/mergegame/getGameReward'), {
                    method: 'POST',
                    body: JSON.stringify({"gameid": 0, "level": currentLevel, "isFreeGame": 0})
                });
                addLog('Started new GemMerge game (paid version)');
            } catch (error) {
                addLog('Paid version failed, trying free version...');
                await adaptiveDelay();
                gameResponse = await fetchWithRetry(getTeraboxUrl('/mergegame/getGameReward'), {
                    method: 'POST',
                    body: JSON.stringify({"gameid": 0, "level": currentLevel, "isFreeGame": 1})
                });
                addLog('Started new GemMerge game (free version)');
            }

            if (!gameResponse.data?.gameid) {
                throw new Error('Failed to get valid game ID');
            }

            gameId = gameResponse.data.gameid;
            addLog(`Game ID: ${gameId}`);
            parseGemMergeRewards(gameResponse.data?.rewards, 'Initial rewards');
        }

        // Store initial/resumed game state
        await saveGameState(gameId, currentLevel);
        
        // Play levels
        for (let level = currentLevel; level <= 100; level++) {
            if (!isRunning) {
                addLog('Game stopped by user');
                await saveGameState(gameId, level);
                break;
            }

            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    addLog(`Attempting level ${level} with ${Math.round(currentGemMergeDelay)}ms base delay...`);
                    
                    // Send level up request
                    const levelUpResponse = await fetchWithRetry(getTeraboxUrl('/mergegame/sendGameLevelup'), {
                        method: 'POST',
                        body: JSON.stringify({
                            "level": level,
                            "isad": false,
                            "gameid": gameId
                        })
                    });

                    if (levelUpResponse.errno === 0) {
                        addLog(`Successfully completed level ${level}`);
                    } else {
                        throw new Error(`Level up failed with errno: ${levelUpResponse.errno}`);
                    }

                    await adaptiveDelay();

                    // Get rewards for next level
                    addLog(`Sending request to get rewards: ${JSON.stringify(requestData)}`);
                    const rewardResponse = await fetchWithRetry(getTeraboxUrl('/mergegame/getGameReward'), {
                        method: 'POST',
                        body: JSON.stringify({
                            "gameid": gameId,
                            "level": level + 1,
                            "isFreeGame": 1
                        })
                    });

                    if (rewardResponse.errno === 0) {
                        parseGemMergeRewards(rewardResponse.data?.rewards, `Level ${level + 1} rewards`);
                    } else {
                        throw new Error(`Failed to get rewards with errno: ${rewardResponse.errno}`);
                    }

                    await adaptiveDelay();

                    // Mark rewards as received
                    addLog(`Sending request to get rewards: ${JSON.stringify(requestData)}`);
                    const gotRewardResponse = await fetchWithRetry(getTeraboxUrl('/mergegame/hasgotReward'), {
                        method: 'POST',
                        body: JSON.stringify({"gameid": gameId})
                    });

                    if (gotRewardResponse.errno !== 0) {
                        addLog(`Warning: hasgotReward returned errno: ${gotRewardResponse.errno}`);
                    }

                    // Update stored state after successful level completion
                    await saveGameState(gameId, level + 1);
                    
                    // If we got here, level was successful
                    break;
                } catch (error) {
                    if (attempt === 1) {
                        addLog(`Failed to complete level ${level} after 2 attempts: ${error.message}`);
                        await delay(currentGemMergeDelay * 2);
                    } else {
                        await adaptiveDelay();
                    }
                }
            }

            // Check if we've reached level 100
            if (level === 100) {
                addLog('Reached level 100! Completing final rewards and restarting...');
                
                // Get final reward for this game session
                try {
                    const finalReward = await fetchWithRetry(getTeraboxUrl('/mergegame/getTotalReward'), {
                        method: 'POST',
                        body: JSON.stringify({"gameid": gameId})
                    });

                    if (finalReward.errno === 0) {
                        parseGemMergeRewards(finalReward.data?.rewards, 'Final game rewards');
                        addLog('GemMerge game session completed successfully');
                        
                        // Clear stored game state
                        await clearGameState();
                        
                        // Return to let the collectCoins function start a new cycle
                        return;
                    } else {
                        addLog(`Warning: Final rewards returned errno: ${finalReward.errno}`);
                    }
                } catch (error) {
                    addLog(`Error getting final rewards: ${error.message}`);
                }
            }

            // Add delay between levels
            await adaptiveDelay();
        }

    } catch (error) {
        addLog(`Error in GemMerge game: ${error.message}`);
        addLog(`Final delay settings - Delay: ${Math.round(currentGemMergeDelay)}ms, Consecutive timeouts: ${consecutiveTimeouts}`);
        
        throw error;
    } finally {
        // Log final statistics
        addLog(`Game session ended. Final delay: ${Math.round(currentGemMergeDelay)}ms`);
        // Reset delays for next session
        currentGemMergeDelay = baseGemMergeDelay;
        consecutiveTimeouts = 0;
    }
}

// Add this new helper function
function adaptiveDelay() {
    const now = Date.now();
    const jitter = Math.random() * 200; // Increased jitter range
    
    // Add pattern detection
    if (timeoutPattern.length >= 5) {
        timeoutPattern.shift();
    }
    timeoutPattern.push(now);
    
    // Check for pattern in timeouts
    if (timeoutPattern.length >= 3) {
        const intervals = [];
        for (let i = 1; i < timeoutPattern.length; i++) {
            intervals.push(timeoutPattern[i] - timeoutPattern[i-1]);
        }
        
        // If we detect a regular pattern, adjust base delay
        const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        const patternDetected = intervals.every(interval => 
            Math.abs(interval - avgInterval) < 1000
        );
        
        if (patternDetected) {
            currentGemMergeDelay = Math.min(maxGemMergeDelay, avgInterval * 1.2);
            addLog(`Pattern detected - Adjusting base delay to ${Math.round(currentGemMergeDelay)}ms`);
        }
    }

    // Dynamic delay calculation
    let finalDelay = currentGemMergeDelay;
    
    // If we had a recent timeout, increase delay more aggressively
    if (now - lastTimeoutTime < 60000) { // Within last minute
        finalDelay *= (1 + (consecutiveTimeouts * 0.5));
    }
    
    // Add success-based reduction
    if (successfulRequestsCount > 5) {
        finalDelay *= Math.max(0.7, 1 - (successfulRequestsCount * 0.05));
    }
    
    // Add jitter and ensure within bounds
    finalDelay = Math.min(maxGemMergeDelay, Math.max(baseGemMergeDelay, finalDelay + jitter));
    
    addLog(`Waiting ${Math.round(finalDelay)}ms before next request... (Success streak: ${successfulRequestsCount})`);
    return delay(finalDelay);
}

// Helper function to save game state
async function saveGameState(gameId, level) {
    return new Promise(resolve => {
        chrome.storage.local.set({
            gemMergeState: {
                gameId: gameId,
                level: level,
                timestamp: Date.now()
            }
        }, resolve);
    });
}

// Helper function to clear game state
async function clearGameState() {
    return new Promise(resolve => {
        chrome.storage.local.remove('gemMergeState', resolve);
    });
}

function parseGemMergeRewards(rewards, context = 'Rewards') {
    if (!rewards || !Array.isArray(rewards)) {
        addLog(`${context}: No rewards received`);
        return;
    }

    addLog(`${context}:`);
    
    let totalCoins = 0;
    let totalStorage = 0;
    let totalPremiumDays = 0;

    rewards.forEach(reward => {
        switch (reward.RewardType) {
            case 9: // Coins
                totalCoins += reward.RewardCount;
                addLog(`- ${reward.RewardCount} coins (${reward.ADTimes} ads available)`);
                break;
            case 3: // Storage
                totalStorage += reward.RewardCount;
                addLog(`- ${formatFileSize(reward.RewardCount)} storage (${reward.ADTimes} ads available)`);
                break;
            case 8: // Premium
                totalPremiumDays += reward.RewardCount;
                addLog(`- ${reward.RewardCount} premium days (${reward.ADTimes} ads available)`);
                break;
            default:
                addLog(`- Unknown reward type ${reward.RewardType}: ${reward.RewardCount} (${reward.ADTimes} ads available)`);
        }
    });

    if (totalCoins > 0 || totalStorage > 0 || totalPremiumDays > 0) {
        addLog('Total rewards received:');
        if (totalCoins > 0) addLog(`- Total coins: ${totalCoins}`);
        if (totalStorage > 0) addLog(`- Total storage: ${formatFileSize(totalStorage)}`);
        if (totalPremiumDays > 0) addLog(`- Total premium days: ${totalPremiumDays}`);
    }
}

function formatFileSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }
    
    return `${size.toFixed(2)} ${units[unitIndex]}`;
}

function parseReward(rewardData) {
    const reward_kind = rewardData?.reward_kind;
    switch (reward_kind) {
        case 9:
            addLog(`Got Coins: ${rewardData.size}`);
            break;
        case 3:
            addLog(`Got Space: ${formatFileSize(rewardData.size)}`);
            break;
        case 6:
            addLog(`Got Catch-up Cards: ${rewardData.size}`);
            break;
        case 8:
            addLog(`Got Premium Days: ${rewardData.size}`);
            break;
        default:
            addLog(`Got Item: ${JSON.stringify(rewardData)}`);
    }
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options = {}, retries = 3) {
    try {
        const cookies = await getTeraboxCookies();
        const cookieString = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');

        const headers = {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Cookie': cookieString,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'
        };

        const response = await fetch(url, {
            method: options.method || 'GET',
            credentials: 'include',
            headers: headers,
            body: options.body,
            ...options
        });

        const data = await response.json();
        
        // Success handling
        if (url.includes('/mergegame/')) {
            successfulRequestsCount++;
            if (consecutiveTimeouts > 0) {
                consecutiveTimeouts--;
                // Gradual delay reduction on success
                currentGemMergeDelay = Math.max(
                    baseGemMergeDelay,
                    currentGemMergeDelay * Math.pow(0.9, Math.min(successfulRequestsCount, 5))
                );
            }
        }
        
        return data;
    } catch (error) {
        if (retries > 0) {
            // Timeout/error handling
            if (url.includes('/mergegame/')) {
                lastTimeoutTime = Date.now();
                consecutiveTimeouts++;
                successfulRequestsCount = 0;
                
                // Exponential backoff with timeout count consideration
                const backoffFactor = 1.5 + (Math.min(consecutiveTimeouts, 5) * 0.2);
                currentGemMergeDelay = Math.min(
                    maxGemMergeDelay,
                    currentGemMergeDelay * backoffFactor
                );
                
                addLog(`Request failed. Increased delay to ${Math.round(currentGemMergeDelay)}ms (Consecutive timeouts: ${consecutiveTimeouts})`);
            }
            
            addLog(`Fetch failed, retrying... (${retries} attempts left)`);
            await adaptiveDelay();
            return fetchWithRetry(url, options, retries - 1);
        }
        throw error;
    }
}

function getTeraboxUrl(path) {
    return `https://${teraboxSubdomain || 'www'}.terabox.com${path}`;
}

async function getUserInfoAndCoinCount() {
    try {
        const userInfoUrl = getTeraboxUrl('/passport/get_info');
        const userInfoResponse = await fetchWithRetry(userInfoUrl);
        
        const coinCountUrl = getTeraboxUrl('/rest/1.0/inte/system/getrecord');
        const coinCountResponse = await fetchWithRetry(coinCountUrl);
        
        coins = coinCountResponse.data.can_used_cnt;
        
        return {
            userInfo: userInfoResponse,
            coinCount: coinCountResponse
        };
    } catch (error) {
        addLog(`Error fetching user info and coin count: ${error.message}`);
        throw error;
    }
}

// Reset daily limit at midnight
function scheduleResetDailyLimit() {
    const now = new Date();
    const night = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1, // the next day
        0, 0, 0 // at 00:00:00 hours
    );
    const msToMidnight = night.getTime() - now.getTime();

    setTimeout(() => {
        dailyLimitReached = false;
        chrome.storage.local.set({ dailyLimitReached: false }).catch(console.error);
        addLog('Daily limit has been reset.');
        scheduleResetDailyLimit(); // Schedule the next reset
    }, msToMidnight);
}

scheduleResetDailyLimit()