chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'collectCoins') {
        playGemMerge();
    }
});

async function playGemMerge() {
    try {
        console.log('Starting GemMerge game');
        // Inicializar el juego GemMerge
        const initResponse = await fetch('https://www.terabox.com/rest/1.0/imact/gemmerge/init', {
            method: 'GET',
            credentials: 'include',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'User-Agent': navigator.userAgent,
                'Origin': 'https://www.terabox.com',
                'Referer': 'https://www.terabox.com/'
            }
        });

        const initData = await initResponse.json();
        
        if (initData.errno !== 0) {
            throw new Error(`Failed to initialize GemMerge. Error code: ${initData.errno}`);
        }

        console.log('Game initialized successfully');
        let gameData = initData.data;
        
        // Jugar mientras el juego esté activo
        while (gameData.game_status === 1) {
            // Calcular el siguiente movimiento
            const moveInfo = calculateMove(gameData.board);
            
            console.log(`Making move: ${JSON.stringify(moveInfo)}`);
            
            // Agregar un retraso variable para simular comportamiento humano
            await delay(Math.random() * 1000 + 500);  // Retraso entre 500ms y 1500ms

            // Realizar el movimiento
            const moveResponse = await fetch('https://www.terabox.com/rest/1.0/imact/gemmerge/move', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'User-Agent': navigator.userAgent,
                    'Origin': 'https://www.terabox.com',
                    'Referer': 'https://www.terabox.com/'
                },
                body: JSON.stringify({
                    move_info: moveInfo,
                    game_id: gameData.game_id
                })
            });

            const moveData = await moveResponse.json();
            
            if (moveData.errno !== 0) {
                throw new Error(`Failed to make move. Error code: ${moveData.errno}`);
            }

            gameData = moveData.data;
            console.log(`Move successful. Current score: ${gameData.score}`);
        }

        console.log('GemMerge game completed');
        chrome.runtime.sendMessage({action: 'gameComplete', score: gameData.score});

    } catch (error) {
        console.error('Error playing GemMerge:', error);
        chrome.runtime.sendMessage({action: 'gameError', error: error.message});
    }
}

function calculateMove(board) {
    // Encontrar movimientos válidos
    const validMoves = [];
    
    // Buscar coincidencias horizontales
    for (let i = 0; i < board.length; i++) {
        for (let j = 0; j < board[i].length - 1; j++) {
            if (board[i][j] !== 0 && board[i][j] === board[i][j + 1]) {
                validMoves.push([i, j, i, j + 1]);
            }
        }
    }

    // Buscar coincidencias verticales
    for (let i = 0; i < board.length - 1; i++) {
        for (let j = 0; j < board[i].length; j++) {
            if (board[i][j] !== 0 && board[i][j] === board[i + 1][j]) {
                validMoves.push([i, j, i + 1, j]);
            }
        }
    }

    // Si hay movimientos válidos, seleccionar uno al azar
    if (validMoves.length > 0) {
        return validMoves[Math.floor(Math.random() * validMoves.length)];
    }

    // Si no hay coincidencias, hacer un movimiento aleatorio válido
    for (let i = 0; i < board.length; i++) {
        for (let j = 0; j < board[i].length - 1; j++) {
            if (board[i][j] !== 0 && board[i][j+1] !== 0) {
                return [i, j, i, j+1];
            }
        }
    }

    throw new Error('No valid moves available');
}

// Función auxiliar para esperar un tiempo determinado
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Función para verificar si estamos en la página correcta de Terabox
function isTeraboxPage() {
    return window.location.hostname.includes('terabox.com');
}

// Inicialización
if (isTeraboxPage()) {
    console.log('TeraBox Coin Collector initialized');
}