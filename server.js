// ====================== 【关键】Render WebSocket 修复补丁（唯一声明区） ======================
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

// 重写 createServer 处理 Render 的 Upgrade 头拦截
const originalCreateServer = http.createServer;
http.createServer = function (...args) {
  const server = originalCreateServer(...args);
  server.on('upgrade', (req, socket, head) => {
    if (req.headers['sec-websocket-key']) {
      const key = req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
      const accept = crypto.createHash('sha1').update(key).digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    }
  });
  return server;
};
// ========================================================================================

// 创建HTTP服务器（健康检查）
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  } else if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>🐷 拱猪 WebSocket 服务器</h1><p>连接地址: wss://' + req.headers.host + '/ws</p>');
  } else {
    res.writeHead(404);
    res.end();
  }
});

// WebSocket 服务器（关键：指定 /ws 路径）
const wss = new WebSocket.Server({ 
  server,
  path: '/ws' // Render 必需：显式声明路径避免路由冲突
});

// ====================== 以下为游戏逻辑（无任何 require 重复） ======================
const rooms = {}; // { roomId: { players: [], gameState: {...} } }

// 特殊牌定义
const SPECIAL_CARDS = {
  'HA': -50, 'HK': -40, 'HQ': -30, 'HJ': -20,
  'H10': -10, 'H9': -10, 'H8': -10, 'H7': -10, 'H6': -10, 
  'H5': -10, 'H4': -10, 'H3': -10, 'H2': -10,
  'SQ': -100, 'DJ': 100, 'C10': 'DOUBLE'
};
const ALL_SPECIALS = Object.keys(SPECIAL_CARDS);
const RANK_ORDER = { 'A':14, 'K':13, 'Q':12, 'J':11, '10':10, '9':9, '8':8, '7':7, '6':6, '5':5, '4':4, '3':3, '2':2 };

// 生成洗牌
function createDeck() {
  const suits = ['H', 'S', 'D', 'C'];
  const ranks = ['A','K','Q','J','10','9','8','7','6','5','4','3','2'];
  return shuffle(suits.flatMap(s => ranks.map(r => s + r)));
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 计算单局分数
function calculateRoundScore(cards) {
  let baseScore = 0;
  let hasDouble = false;
  const collected = [];
  
  cards.forEach(card => {
    if (card === 'C10') hasDouble = true;
    if (SPECIAL_CARDS[card]) {
      collected.push(card);
      if (SPECIAL_CARDS[card] !== 'DOUBLE') baseScore += SPECIAL_CARDS[card];
    }
  });
  
  // 特殊奖励（互斥）
  let bonus = 0;
  const specialSet = new Set(collected);
  if (ALL_SPECIALS.every(c => specialSet.has(c)) && collected.length === 16) {
    bonus = 500;
  } else if (collected.length === 2 && specialSet.has('DJ') && specialSet.has('SQ') && !specialSet.has('C10')) {
    bonus = 200;
  } else if (collected.length === 1 && specialSet.has('C10')) {
    bonus = 50;
  }
  
  if (hasDouble) baseScore *= 2;
  return { total: baseScore + bonus, details: { base: baseScore, bonus, hasDouble, collected } };
}

// 比较同花色牌大小
function compareCards(c1, c2) {
  return RANK_ORDER[c1.slice(1)] - RANK_ORDER[c2.slice(1)];
}

// ====================== WebSocket 事件处理 ======================
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room');
  const playerName = decodeURIComponent(url.searchParams.get('name') || '玩家');
  
  if (!roomId || !/^\d{6}$/.test(roomId)) {
    ws.close(4001, '无效房间码（需6位数字）');
    return;
  }
  
  // 初始化房间
  if (!rooms[roomId]) {
    rooms[roomId] = {
      players: [],
      gameState: { trickNumber: 0, leadSuit: null, currentTrick: [], gameOver: false }
    };
  }
  
  const room = rooms[roomId];
  const playerIndex = room.players.length;
  
  if (playerIndex >= 4) {
    ws.send(JSON.stringify({ type: 'error', message: '房间已满' }));
    ws.close();
    return;
  }
  
  // 添加玩家
  const playerId = Date.now() + Math.random().toString(36).slice(2, 8);
  const player = { 
    id: playerId,
    name: playerName,
    ws,
    hand: [],
    isHost: playerIndex === 0
  };
  
  room.players.push(player);
  
  // 通知房间状态
  broadcast(roomId, {
    type: 'room_joined',
    players: room.players.map(p => ({ 
      name: p.name, 
      score: 0,
      isCurrentTurn: false 
    })),
    playerCount: room.players.length,
    isHost: player.isHost
  });
  
  // 4人满自动开始
  if (room.players.length === 4 && !room.gameState.gameStarted) {
    startGame(roomId);
  }
  
  // 消息处理
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'chat') {
        broadcast(roomId, {
          type: 'chat',
          name: player.name,
          text: msg.text.substring(0, 50)
        });
      } else if (msg.type === 'play_card' && room.gameState.currentPlayerIndex === playerIndex) {
        handlePlayCard(roomId, playerIndex, msg.card);
      }
    } catch (e) {
      console.error('消息处理错误:', e);
    }
  });
  
  ws.on('close', () => {
    const idx = room.players.findIndex(p => p.id === playerId);
    if (idx !== -1) {
      room.players.splice(idx, 1);
      broadcast(roomId, { type: 'error', message: `${player.name} 已离开` });
      if (room.players.length === 0) delete rooms[roomId];
    }
  });
});

// 广播
function broadcast(roomId, msg) {
  const room = rooms[roomId];
  if (!room) return;
  room.players.forEach(p => {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify(msg));
    }
  });
}

// 游戏开始
function startGame(roomId) {
  const room = rooms[roomId];
  const deck = createDeck();
  
  // 发牌
  room.players.forEach((p, i) => {
    p.hand = deck.slice(i * 13, (i + 1) * 13);
    p.ws.send(JSON.stringify({ type: 'game_start', hand: p.hand }));
  });
  
  // 初始化游戏状态
  room.gameState = {
    currentTrick: [],
    trickNumber: 0,
    leadSuit: null,
    currentPlayerIndex: 0,
    scores: room.players.map(() => ({ total: 0 })),
    collectedCards: room.players.map(() => []),
    gameStarted: true,
    gameOver: false
  };
  
  broadcast(roomId, { type: 'game_start' });
  setTimeout(() => notifyTurn(roomId, 0), 1000);
}

// 通知出牌
function notifyTurn(roomId, idx) {
  const room = rooms[roomId];
  if (room.gameState.gameOver) return;
  
  room.gameState.currentPlayerIndex = idx;
  broadcast(roomId, { type: 'your_turn', leadSuit: room.gameState.leadSuit });
}

// 处理出牌
function handlePlayCard(roomId, playerIndex, cardStr) {
  const room = rooms[roomId];
  const player = room.players[playerIndex];
  
  if (!player.hand.includes(cardStr)) return;
  
  // 移除手牌
  player.hand = player.hand.filter(c => c !== cardStr);
  
  // 记录出牌
  room.gameState.currentTrick.push({ playerIndex, card: cardStr });
  
  // 设置领出花色
  if (!room.gameState.leadSuit) room.gameState.leadSuit = cardStr[0];
  
  // 广播出牌
  broadcast(roomId, {
    type: 'card_played',
    card: cardStr,
    position: playerIndex,
    name: player.name,
    leadSuit: room.gameState.leadSuit,
    trickPoints: room.gameState.currentTrick
      .filter(t => SPECIAL_CARDS[t.card] && SPECIAL_CARDS[t.card] !== 'DOUBLE')
      .reduce((sum, t) => sum + SPECIAL_CARDS[t.card], 0)
  });
  
  // 检查是否完成一轮
  if (room.gameState.currentTrick.length === 4) {
    setTimeout(() => resolveTrick(roomId), 1000);
  } else {
    setTimeout(() => notifyTurn(roomId, (playerIndex + 1) % 4), 300);
  }
}

// 结算一轮
function resolveTrick(roomId) {
  const room = rooms[roomId];
  const trick = room.gameState.currentTrick;
  const leadSuit = room.gameState.leadSuit;
  
  // 找赢家（同花色最大）
  let winnerIdx = 0;
  let maxCard = trick[0].card;
  
  for (let i = 1; i < 4; i++) {
    const card = trick[i].card;
    if (card[0] === leadSuit) {
      if (maxCard[0] !== leadSuit || compareCards(card, maxCard) > 0) {
        maxCard = card;
        winnerIdx = i;
      }
    }
  }
  
  const winnerPlayerIndex = trick[winnerIdx].playerIndex;
  const winner = room.players[winnerPlayerIndex];
  
  // 收集牌
  const trickCards = trick.map(t => t.card);
  room.gameState.collectedCards[winnerPlayerIndex].push(...trickCards);
  
  // 通知
  broadcast(roomId, {
    type: 'trick_end',
    trickNumber: room.gameState.trickNumber + 1,
    winnerName: winner.name,
    points: trickCards
      .filter(c => SPECIAL_CARDS[c] && SPECIAL_CARDS[c] !== 'DOUBLE')
      .reduce((sum, c) => sum + SPECIAL_CARDS[c], 0)
  });
  
  // 检查13轮结束
  room.gameState.trickNumber++;
  if (room.gameState.trickNumber >= 13) {
    setTimeout(() => endRound(roomId), 1500);
  } else {
    room.gameState.currentTrick = [];
    room.gameState.leadSuit = null;
    setTimeout(() => notifyTurn(roomId, winnerPlayerIndex), 1500);
  }
}

// 结束一局
function endRound(roomId) {
  const room = rooms[roomId];
  
  // 计算分数
  room.gameState.collectedCards.forEach((cards, i) => {
    const { total } = calculateRoundScore(cards);
    room.gameState.scores[i].total += total;
  });
  
  // 检查游戏结束
  let gameOver = false;
  let winnerName = '';
  const loserIdx = room.gameState.scores.findIndex(s => s.total <= -1500);
  
  if (loserIdx !== -1) {
    gameOver = true;
    const winnerIdx = room.gameState.scores
      .map((s, i) => ({ score: s.total, idx: i }))
      .sort((a, b) => b.score - a.score)[0].idx;
    winnerName = room.players[winnerIdx].name;
  }
  
  // 通知
  broadcast(roomId, {
    type: 'round_end',
    scores: room.gameState.scores.map((s, i) => ({
      name: room.players[i].name,
      total: s.total
    })),
    gameOver,
    winner: winnerName
  });
  
  room.gameState.gameOver = gameOver;
  
  // 未结束则准备新局
  if (!gameOver) {
    setTimeout(() => {
      room.gameState = {
        currentTrick: [],
        trickNumber: 0,
        leadSuit: null,
        currentPlayerIndex: 0,
        scores: [...room.gameState.scores],
        collectedCards: room.players.map(() => []),
        gameStarted: true,
        gameOver: false
      };
      
      const deck = createDeck();
      room.players.forEach((p, i) => {
        p.hand = deck.slice(i * 13, (i + 1) * 13);
        p.ws.send(JSON.stringify({ type: 'game_start', hand: p.hand }));
      });
      
      broadcast(roomId, { type: 'game_start' });
      setTimeout(() => notifyTurn(roomId, 0), 1000);
    }, 3000);
  }
}

// 启动服务器
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 拱猪服务器运行中 - ws://localhost:${PORT}/ws`);
  console.log(`✅ 健康检查: http://localhost:${PORT}/health`);
  console.log(`🌐 Render 访问: https://gongzhu-server.onrender.com/health`);
});
