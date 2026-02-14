// server.js - 拱猪游戏服务器 (Node.js)
// 依赖: npm install ws
const WebSocket = require('ws');
const http = require('http');

// 创建HTTP服务器（用于健康检查）
const server = http.createServer((req, res) => {
  if(req.url === '/health') {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('OK');
  } else {
    res.writeHead(404);
    res.end();
  }
});

// WebSocket服务器
const wss = new WebSocket.Server({ server });
const rooms = {}; // { roomId: { players: [], gameState: {...} } }

// 特殊牌定义
const SPECIAL_CARDS = {
  'HA': -50, 'HK': -40, 'HQ': -30, 'HJ': -20,
  'H10': -10, 'H9': -10, 'H8': -10, 'H7': -10, 'H6': -10, 
  'H5': -10, 'H4': -10, 'H3': -10, 'H2': -10,
  'SQ': -100, 'DJ': 100, 'C10': 'DOUBLE'
};
const ALL_SPECIALS = Object.keys(SPECIAL_CARDS);

// 生成一副牌（52张）
function createDeck() {
  const suits = ['H', 'S', 'D', 'C']; // 红桃、黑桃、方块、梅花
  const ranks = ['A','K','Q','J','10','9','8','7','6','5','4','3','2'];
  const deck = [];
  for(let s of suits) {
    for(let r of ranks) {
      deck.push(s + r);
    }
  }
  return deck;
}

// 洗牌
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// 计算单局分数
function calculateRoundScore(cards) {
  let baseScore = 0;
  let hasDouble = false;
  const collected = [];
  
  // 统计特殊牌
  for(let card of cards) {
    if(card === 'C10') hasDouble = true;
    if(SPECIAL_CARDS[card]) {
      collected.push(card);
      if(SPECIAL_CARDS[card] !== 'DOUBLE') {
        baseScore += SPECIAL_CARDS[card];
      }
    }
  }
  
  // 特殊奖励判定（互斥，取最高）
  let bonus = 0;
  const specialSet = new Set(collected);
  const hasAllSpecials = ALL_SPECIALS.every(c => specialSet.has(c));
  
  if(hasAllSpecials && collected.length === 16) {
    bonus = 500; // 全收16张
  } else if(
    collected.length === 2 && 
    specialSet.has('DJ') && 
    specialSet.has('SQ') && 
    !specialSet.has('C10')
  ) {
    bonus = 200; // 仅♦J+♠Q
  } else if(collected.length === 1 && specialSet.has('C10')) {
    bonus = 50; // 仅♣10
  }
  
  // 翻倍处理
  if(hasDouble) baseScore *= 2;
  
  return { 
    total: baseScore + bonus, 
    details: { base: baseScore, bonus, hasDouble, collected } 
  };
}

// 判断出牌是否合法
function isValidPlay(card, hand, leadSuit, trick) {
  // 首出者无限制
  if(!leadSuit) return true;
  
  // 检查是否有跟出花色
  const hasLeadSuit = hand.some(c => c[0] === leadSuit);
  if(!hasLeadSuit) return true; // 无此花色可垫牌
  
  // 必须跟出同花色
  return card[0] === leadSuit;
}

// 比较同花色牌大小
function compareCards(card1, card2, suit) {
  const rankOrder = { 'A':14, 'K':13, 'Q':12, 'J':11, '10':10, '9':9, '8':8, '7':7, '6':6, '5':5, '4':4, '3':3, '2':2 };
  return rankOrder[card1.slice(1)] - rankOrder[card2.slice(1)];
}

// 处理消息
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room');
  const playerName = decodeURIComponent(url.searchParams.get('name') || '玩家');
  
  if(!roomId || !/^\d{6}$/.test(roomId)) {
    ws.close(4001, '无效房间码');
    return;
  }
  
  // 初始化房间
  if(!rooms[roomId]) {
    rooms[roomId] = {
      players: [],
      gameState: {
        currentTrick: [],
        trickNumber: 0,
        leadSuit: null,
        currentPlayerIndex: 0,
        scores: [{total:0},{total:0},{total:0},{total:0}],
        gameOver: false
      }
    };
  }
  
  const room = rooms[roomId];
  const playerIndex = room.players.length;
  
  if(playerIndex >= 4) {
    ws.send(JSON.stringify({ type: 'error', message: '房间已满' }));
    ws.close();
    return;
  }
  
  // 添加玩家
  const player = { 
    id: Date.now() + Math.random().toString(36).slice(2, 8),
    name: playerName,
    ws,
    hand: [],
    score: 0,
    isHost: playerIndex === 0
  };
  
  room.players.push(player);
  player.ws = ws;
  
  // 通知所有玩家
  broadcast(roomId, {
    type: 'room_joined',
    players: room.players.map(p => ({ 
      name: p.name, 
      score: p.score,
      isCurrentTurn: false 
    })),
    playerCount: room.players.length,
    isHost: player.isHost
  });
  
  // 游戏开始（4人满）
  if(room.players.length === 4 && !room.gameState.gameStarted) {
    startGame(roomId);
  }
  
  // 消息处理
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      handlePlayerMessage(roomId, player.id, msg);
    } catch(e) {
      console.error('消息解析错误:', e);
    }
  });
  
  // 断开处理
  ws.on('close', () => {
    const idx = room.players.findIndex(p => p.id === player.id);
    if(idx !== -1) {
      room.players.splice(idx, 1);
      broadcast(roomId, { 
        type: 'error', 
        message: `${player.name} 已离开房间` 
      });
      
      // 清理空房间
      if(room.players.length === 0) {
        delete rooms[roomId];
      }
    }
  });
});

// 广播消息
function broadcast(roomId, message) {
  if(!rooms[roomId]) return;
  rooms[roomId].players.forEach(p => {
    if(p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify(message));
    }
  });
}

// 游戏开始
function startGame(roomId) {
  const room = rooms[roomId];
  room.gameState = {
    currentTrick: [],
    trickNumber: 0,
    leadSuit: null,
    currentPlayerIndex: 0, // 随机决定，简化：固定0号位
    scores: room.players.map(() => ({ total: 0 })),
    gameOver: false,
    gameStarted: true,
    collectedCards: room.players.map(() => []) // 每位玩家收的牌
  };
  
  // 发牌
  let deck = shuffle(createDeck());
  room.players.forEach((p, i) => {
    p.hand = deck.slice(i * 13, (i + 1) * 13);
    p.ws.send(JSON.stringify({
      type: 'game_start',
      hand: p.hand
    }));
  });
  
  // 通知所有玩家游戏开始
  broadcast(roomId, { type: 'game_start' });
  
  // 通知首位出牌者
  setTimeout(() => {
    notifyTurn(roomId, 0);
  }, 1000);
}

// 通知出牌
function notifyTurn(roomId, playerIndex) {
  const room = rooms[roomId];
  if(room.gameState.gameOver) return;
  
  room.gameState.currentPlayerIndex = playerIndex;
  const player = room.players[playerIndex];
  
  // 更新玩家UI状态
  broadcast(roomId, {
    type: 'your_turn',
    playerId: player.id,
    leadSuit: room.gameState.leadSuit
  });
}

// 处理出牌
function handlePlayerMessage(roomId, playerId, msg) {
  const room = rooms[roomId];
  if(!room || room.gameState.gameOver) return;
  
  const playerIndex = room.players.findIndex(p => p.id === playerId);
  if(playerIndex === -1) return;
  
  switch(msg.type) {
    case 'play_card':
      if(playerIndex !== room.gameState.currentPlayerIndex) return;
      
      const card = msg.card;
      const player = room.players[playerIndex];
      
      // 简化校验：实际应检查手牌和规则
      if(!player.hand.includes(card)) {
        player.ws.send(JSON.stringify({ type: 'error', message: '无效卡牌' }));
        return;
      }
      
      // 从手牌移除
      player.hand = player.hand.filter(c => c !== card);
      
      // 记录出牌
      room.gameState.currentTrick.push({ 
        playerIndex, 
        card,
        points: SPECIAL_CARDS[card] || 0 
      });
      
      // 确定领出花色
      if(!room.gameState.leadSuit) {
        room.gameState.leadSuit = card[0];
      }
      
      // 计算本轮分数（仅显示，结算时用）
      const trickPoints = room.gameState.currentTrick
        .filter(t => SPECIAL_CARDS[t.card] && SPECIAL_CARDS[t.card] !== 'DOUBLE')
        .reduce((sum, t) => sum + (typeof SPECIAL_CARDS[t.card] === 'number' ? SPECIAL_CARDS[t.card] : 0), 0);
      
      // 广播出牌
      broadcast(roomId, {
        type: 'card_played',
        card,
        position: playerIndex,
        playerId,
        name: player.name,
        leadSuit: room.gameState.leadSuit,
        trickPoints
      });
      
      // 检查是否完成一轮
      if(room.gameState.currentTrick.length === 4) {
        setTimeout(() => resolveTrick(roomId), 1000);
      } else {
        // 通知下家
        const nextIndex = (playerIndex + 1) % 4;
        setTimeout(() => notifyTurn(roomId, nextIndex), 300);
      }
      break;
      
    case 'chat':
      broadcast(roomId, {
        type: 'chat',
        name: room.players[playerIndex].name,
        text: msg.text.substring(0, 50)
      });
      break;
  }
}

// 结算一轮
function resolveTrick(roomId) {
  const room = rooms[roomId];
  const trick = room.gameState.currentTrick;
  const leadSuit = room.gameState.leadSuit;
  
  // 找出最大牌（同花色）
  let winnerIndex = 0;
  let maxCard = trick[0].card;
  
  for(let i=1; i<4; i++) {
    const card = trick[i].card;
    // 只比较领出花色的牌
    if(card[0] === leadSuit && maxCard[0] === leadSuit) {
      if(compareCards(card, maxCard, leadSuit) > 0) {
        maxCard = card;
        winnerIndex = i;
      }
    } else if(maxCard[0] !== leadSuit && card[0] === leadSuit) {
      // 对方出领出花色而当前最大不是
      maxCard = card;
      winnerIndex = i;
    }
  }
  
  const winnerPlayerIndex = trick[winnerIndex].playerIndex;
  const winner = room.players[winnerPlayerIndex];
  
  // 收集本轮所有牌
  const trickCards = trick.map(t => t.card);
  room.gameState.collectedCards[winnerPlayerIndex].push(...trickCards);
  
  // 通知结算
  broadcast(roomId, {
    type: 'trick_end',
    trickNumber: room.gameState.trickNumber + 1,
    winnerName: winner.name,
    winnerIndex,
    points: trickCards
      .filter(c => SPECIAL_CARDS[c] && SPECIAL_CARDS[c] !== 'DOUBLE')
      .reduce((sum, c) => sum + SPECIAL_CARDS[c], 0)
  });
  
  // 检查是否13轮结束
  room.gameState.trickNumber++;
  if(room.gameState.trickNumber >= 13) {
    setTimeout(() => endRound(roomId), 1500);
  } else {
    // 重置本轮状态，赢家先出
    room.gameState.currentTrick = [];
    room.gameState.leadSuit = null;
    setTimeout(() => notifyTurn(roomId, winnerPlayerIndex), 1500);
  }
}

// 结束一局
function endRound(roomId) {
  const room = rooms[roomId];
  
  // 计算每位玩家本局分数
  const roundScores = room.gameState.collectedCards.map((cards, i) => {
    const result = calculateRoundScore(cards);
    return {
      playerIndex: i,
      score: result.total,
      details: result.details
    };
  });
  
  // 更新总分
  roundScores.forEach(rs => {
    room.gameState.scores[rs.playerIndex].total += rs.score;
  });
  
  // 检查游戏结束（任一玩家≤-1500）
  let gameOver = false;
  let winnerName = '';
  const loser = room.gameState.scores.findIndex(s => s.total <= -1500);
  if(loser !== -1) {
    gameOver = true;
    // 胜者为分数最高者（简化）
    const winnerIndex = room.gameState.scores
      .map((s,i) => ({score:s.total, index:i}))
      .sort((a,b) => b.score - a.score)[0].index;
    winnerName = room.players[winnerIndex].name;
  }
  
  // 通知玩家
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
  
  // 游戏结束则清理（保留房间供查看）
  if(gameOver) {
    // 不自动清理，玩家可查看结果
    console.log(`[房间${roomId}] 游戏结束`);
  } else {
    // 准备下一局（简化：不洗牌，直接重置）
    setTimeout(() => {
      room.gameState = {
        currentTrick: [],
        trickNumber: 0,
        leadSuit: null,
        currentPlayerIndex: 0,
        scores: [...room.gameState.scores], // 保留总分
        gameOver: false,
        collectedCards: room.players.map(() => [])
      };
      
      // 重新发牌
      let deck = shuffle(createDeck());
      room.players.forEach((p, i) => {
        p.hand = deck.slice(i * 13, (i + 1) * 13);
        p.ws.send(JSON.stringify({
          type: 'game_start',
          hand: p.hand
        }));
      });
      
      broadcast(roomId, { type: 'game_start' });
      setTimeout(() => notifyTurn(roomId, 0), 1000);
    }, 3000);
  }
}

// 启动服务器
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 拱猪服务器运行中 - ws://localhost:${PORT}`);
  console.log(`✅ 健康检查: http://localhost:${PORT}/health`);
});