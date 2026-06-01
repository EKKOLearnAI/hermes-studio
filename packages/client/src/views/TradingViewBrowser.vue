
<template>
  <div class="trading-view-container">
    <div class="header">
      <h2>TradingView 圖表瀏覽器</h2>
      <div class="controls">
        <input
          v-model="symbolInput"
          placeholder="輸入股票代碼 (如: AAPL, MSFT, NVDA)"
          @keyup.enter="loadChart"
        />
        <select v-model="interval" @change="loadChart">
          <option value="1">1分鐘</option>
          <option value="5">5分鐘</option>
          <option value="15">15分鐘</option>
          <option value="30">30分鐘</option>
          <option value="60">小時</option>
          <option value="D">日線</option>
          <option value="W">週線</option>
          <option value="M">月線</option>
        </select>
        <button @click="loadChart">載入圖表</button>
        <button @click="refreshChart">重新整理</button>
      </div>
    </div>
    <div class="chart-wrapper">
      <TradingViewChart
        :symbol="currentSymbol"
        :interval="currentInterval"
        ref="chartRef"
      />
    </div>

    <div class="info-panel">
      <h3>圖表資訊</h3>
      <p>目前顯示: {{ currentSymbol }}</p>
      <p>時間範圍: {{ currentInterval }}</p>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import TradingViewChart from '@/components/trading-view/TradingViewChart.vue'

const symbolInput = ref('AAPL')
const interval = ref('D')
const currentSymbol = ref('AAPL')
const currentInterval = ref('D')
const chartRef = ref(null)

const loadChart = () => {
  currentSymbol.value = symbolInput.value.toUpperCase()
  currentInterval.value = interval.value
  // 重新載入圖表
}

const refreshChart = () => {
  if (chartRef.value && chartRef.value.refreshChart) {
    chartRef.value.refreshChart()
  }
}

onMounted(() => {
  console.log('TradingView 圖表瀏覽器已載入')
})
</script>

<style scoped>
.trading-view-container {
  padding: 20px;
  background: #1e1e1e;
  min-height: 80vh;
}

.header {
  margin-bottom: 20px;
  padding: 15px;
  background: #2d2d2d;
  border-radius: 8px;
}

.header h2 {
  margin: 0 0 15px 0;
  color: #fff;
}

.controls {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.controls input {
  padding: 8px 12px;
  border-radius: 4px;
  border: 1px solid #444;
  background: #333;
  color: white;
  min-width: 150px;
}

.controls select {
  padding: 8px 12px;
  border-radius: 4px;
  border: 1px solid #444;
  background: #333;
  color: white;
}

.controls button {
  padding: 8px 15px;
  border-radius: 4px;
  border: none;
  background: #007bff;
  color: white;
  cursor: pointer;
}

.controls button:hover {
  background: #0056b3;
}

.chart-wrapper {
  background: #000;
  border-radius: 8px;
  overflow: hidden;
  height: 600px;
  margin-bottom: 20px;
}

.info-panel {
  background: #2d2d2d;
  padding: 15px;
  border-radius: 8px;
  color: #fff;
}

.info-panel p {
  margin: 5px 0;
}
</style>
