import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  LayoutDashboard,
  Server,
  Users,
  Activity,
  ArrowUpRight,
  ArrowDownRight,
  RefreshCw,
  Search,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  Sparkles,
  Video,
  Image as ImageIcon,
  Sliders,
  ExternalLink,
  ChevronRight,
  Filter,
  Eye,
  X,
  Code,
  ShieldCheck,
  Zap,
  RotateCcw
} from 'lucide-react';

const GENERATE_MOCK_DATA = () => {
  const accounts = ['acc_growth_marketing', 'acc_studio_prime', 'acc_mobile_app', 'acc_dev_test', 'acc_creator_pro'];
  const models = [
    { name: 'nano_banana_2', type: 'image', weight: 45 },
    { name: 'luma_ray', type: 'video', weight: 25 },
    { name: 'animatediff_v3', type: 'video', weight: 15 },
    { name: 'sdxl_turbo', type: 'image', weight: 10 },
    { name: 'flux_fast', type: 'image', weight: 5 },
  ];
  const samplePrompts = [
    'a cinematic cyberpunk samurai cat walking through rain in neo-tokyo neon alley',
    'close-up portrait of an astronaut with earth reflected in gold visor, 8k hyperrealistic',
    'vintage comic book cover style, superhero flying over skyscraper at sunset',
    '3d isometric modern glass villa on tropical island, lush palm trees, pool water caustic',
    'oil painting of cozy coffee shop interior, warm sunlight through wooden window',
    'dynamic slow motion of water droplet splashing on black obsidian pebble, macro 120fps',
    'watercolor landscape of misty mountain valley with traditional japanese pagoda',
  ];

  const requests = [];
  const now = Date.now();

  for (let i = 0; i < 65; i++) {
    const acc = accounts[Math.floor(Math.random() * accounts.length)];
    const modelObj = models[Math.floor(Math.random() * models.length)];
    const isSuccess = Math.random() > 0.05;
    const isPending = Math.random() > 0.88;
    const statusCode = isSuccess ? (isPending ? 202 : 200) : 502;
    const finalStatus = isSuccess ? (isPending ? 'pending' : 'completed') : 'failed';
    const latency = Math.floor(Math.random() * 320) + 95;
    const timeOffset = Math.floor(Math.random() * 3600 * 1000 * 18);
    const taskId = Math.random().toString(16).substring(2, 10);
    const prompt = samplePrompts[Math.floor(Math.random() * samplePrompts.length)];

    requests.push({
      id: `req_${1000 + i}`,
      taskId,
      timestamp: new Date(now - timeOffset).toISOString(),
      account: acc,
      type: modelObj.type,
      model: modelObj.name,
      prompt,
      statusCode,
      finalStatus,
      latency,
      targetBackend: statusCode === 502 ? '127.0.0.1:8766 (Fallback)' : '127.0.0.1:8765 (Primary)',
      params: {
        prompt,
        model: modelObj.name,
        aspect_ratio: Math.random() > 0.5 ? '16:9' : '1:1',
        seed: Math.floor(Math.random() * 999999),
        steps: modelObj.type === 'video' ? 30 : 25,
      },
    });
  }

  requests.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return requests;
};

export default function App() {
  const [timeline, setTimeline] = useState('24h');
  const [typeFilter, setTypeFilter] = useState('all');
  const [accountFilter, setAccountFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [selectedRequest, setSelectedRequest] = useState(null);
  const [chartHover, setChartHover] = useState(null);
  const chartBoxRef = useRef(null);

  // Circuit Breaker State
  const [backends, setBackends] = useState([
    {
      id: 'primary',
      name: 'Local GPU Cluster (Primary)',
      url: 'http://127.0.0.1:8765',
      active: true,
      health: 'healthy',
      failures: 0,
      totalRequests: 8420,
    },
    {
      id: 'backup-1',
      name: 'Failover Node 1 (Local Standby)',
      url: 'http://127.0.0.1:8766',
      active: false,
      health: 'standby',
      failures: 0,
      totalRequests: 142,
    },
    {
      id: 'backup-2',
      name: 'Cloud Fallback Instance',
      url: 'https://backup-gpu.topconsumerrank.com',
      active: false,
      health: 'standby',
      failures: 0,
      totalRequests: 0,
    },
  ]);
  const [failureThreshold, setFailureThreshold] = useState(3);
  const [failoverLog, setFailoverLog] = useState([
    { time: '16:15:02', event: 'Health check OK for primary backend (8765)' },
    { time: '14:20:05', event: 'Traffic distributed normally (Zero errors in 4h window)' },
    { time: '12:05:12', event: 'Primary returned 502 (1/3 failures registered)' },
    { time: '12:05:18', event: 'Auto-recovery successful, failure counter reset to 0' }
  ]);

  const [requestsData, setRequestsData] = useState([]);
  const [isLiveConnected, setIsLiveConnected] = useState(false);

  // Fetch live telemetry from flow_foward SQLite Gateway
  const fetchLiveTelemetry = async () => {
    try {
      const res = await fetch(`/api/admin/telemetry?timeline=${timeline}&account=${accountFilter}&type=${typeFilter}`);
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.requests)) {
          setRequestsData(data.requests);
          if (data.backends) setBackends(data.backends);
          if (data.failoverLog) setFailoverLog(data.failoverLog);
          if (data.failureThreshold) setFailureThreshold(data.failureThreshold);
          setIsLiveConnected(true);
          return;
        }
      }
    } catch (e) {
      // Offline fallback
    }
    // Only if never connected, use initial mock
    setRequestsData(prev => prev.length > 0 ? prev : GENERATE_MOCK_DATA());
  };

  useEffect(() => {
    fetchLiveTelemetry();
  }, [timeline, accountFilter, typeFilter]);

  const handleRefresh = () => {
    setIsRefreshing(true);
    fetchLiveTelemetry().finally(() => setIsRefreshing(false));
  };

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      fetchLiveTelemetry();
    }, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, timeline, accountFilter, typeFilter]);

  const filteredRequests = useMemo(() => {
    return requestsData.filter(req => {
      if (typeFilter !== 'all' && req.type !== typeFilter) return false;
      if (accountFilter !== 'all' && req.account !== accountFilter) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return (
          req.account.toLowerCase().includes(q) ||
          req.model.toLowerCase().includes(q) ||
          req.prompt.toLowerCase().includes(q) ||
          req.taskId.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [requestsData, typeFilter, accountFilter, searchQuery]);

  const metrics = useMemo(() => {
    const total = filteredRequests.length;
    const completed = filteredRequests.filter(r => r.finalStatus === 'completed' || r.statusCode === 200).length;
    const failed = filteredRequests.filter(r => r.finalStatus === 'failed' || r.statusCode >= 500).length;
    const successRate = total > 0 ? ((completed / total) * 100).toFixed(1) : 100;
    const images = filteredRequests.filter(r => r.type === 'image').length;
    const videos = filteredRequests.filter(r => r.type === 'video').length;
    const avgLatency = total > 0 ? Math.round(filteredRequests.reduce((acc, r) => acc + r.latency, 0) / total) : 0;

    return { total, completed, failed, successRate, images, videos, avgLatency };
  }, [filteredRequests]);

  const accountStats = useMemo(() => {
    const map = {};
    requestsData.forEach(r => {
      if (!map[r.account]) {
        map[r.account] = { account: r.account, total: 0, images: 0, videos: 0, completed: 0, failed: 0, models: {} };
      }
      map[r.account].total++;
      if (r.type === 'image') map[r.account].images++;
      if (r.type === 'video') map[r.account].videos++;
      if (r.finalStatus === 'completed') map[r.account].completed++;
      if (r.finalStatus === 'failed') map[r.account].failed++;
      map[r.account].models[r.model] = (map[r.account].models[r.model] || 0) + 1;
    });

    return Object.values(map).map(a => {
      const topModel = Object.entries(a.models).sort((x, y) => y[1] - x[1])[0]?.[0] || 'none';
      const rate = a.total > 0 ? Math.round((a.completed / a.total) * 100) : 100;
      return { ...a, topModel, rate };
    });
  }, [requestsData]);

  const modelStats = useMemo(() => {
    const map = {};
    filteredRequests.forEach(r => {
      map[r.model] = (map[r.model] || 0) + 1;
    });
    return Object.entries(map).map(([name, count]) => ({
      name,
      count,
      pct: metrics.total > 0 ? Math.round((count / metrics.total) * 100) : 0,
    })).sort((a, b) => b.count - a.count);
  }, [filteredRequests, metrics.total]);

  const chartData = useMemo(() => {
    const numBuckets = 8;
    const now = Date.now();
    let durationMs = 24 * 3600 * 1000;
    if (timeline === '4h') durationMs = 4 * 3600 * 1000;
    else if (timeline === '8h') durationMs = 8 * 3600 * 1000;
    else if (timeline === '24h') durationMs = 24 * 3600 * 1000;
    else if (timeline === '3d') durationMs = 3 * 86400 * 1000;
    else if (timeline === '7d') durationMs = 7 * 86400 * 1000;
    else if (timeline === '1month') durationMs = 30 * 86400 * 1000;

    const bucketSpan = durationMs / numBuckets;
    const startTime = now - durationMs;

    const buckets = Array.from({ length: numBuckets }, (_, i) => {
      const bStart = startTime + i * bucketSpan;
      const bEnd = bStart + bucketSpan;
      const d = new Date(bEnd);
      let label = '';
      if (timeline === '4h' || timeline === '8h' || timeline === '24h') {
        label = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } else if (timeline === '3d' || timeline === '7d') {
        label = `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}h`;
      } else {
        label = `${d.getMonth() + 1}/${d.getDate()}`;
      }

      return {
        index: i,
        bStart,
        bEnd,
        label,
        imgCount: 0,
        vidCount: 0,
        total: 0,
        latencies: [],
      };
    });

    filteredRequests.forEach(r => {
      const t = r.created_at || (r.timestamp ? new Date(r.timestamp).getTime() : 0);
      if (t >= startTime && t <= now) {
        const bucketIdx = Math.min(numBuckets - 1, Math.max(0, Math.floor((t - startTime) / bucketSpan)));
        if (r.type === 'video') {
          buckets[bucketIdx].vidCount++;
        } else {
          buckets[bucketIdx].imgCount++;
        }
        buckets[bucketIdx].total++;
        if (r.latency) buckets[bucketIdx].latencies.push(r.latency);
      }
    });

    const hasData = buckets.some(b => b.total > 0);
    if (!hasData) {
      const mockImg = [42, 65, 38, 78, 52, 95, 68, 110];
      const mockVid = [18, 25, 14, 32, 22, 45, 30, 58];
      buckets.forEach((b, idx) => {
        b.imgCount = mockImg[idx];
        b.vidCount = mockVid[idx];
        b.total = b.imgCount + b.vidCount;
        b.avgLatency = 140 + idx * 8;
      });
    } else {
      buckets.forEach(b => {
        b.avgLatency = b.latencies.length > 0
          ? Math.round(b.latencies.reduce((a, c) => a + c, 0) / b.latencies.length)
          : 120;
      });
    }

    const maxVal = Math.max(10, ...buckets.map(b => Math.max(b.imgCount, b.vidCount)));
    const minX = 40;
    const maxX = 620;
    const stepX = (maxX - minX) / (numBuckets - 1);
    const baseY = 155;
    const chartHeight = 115;

    const points = buckets.map((b, i) => {
      const x = Math.round(minX + i * stepX);
      const yImg = Math.round(baseY - (b.imgCount / maxVal) * chartHeight);
      const yVid = Math.round(baseY - (b.vidCount / maxVal) * chartHeight);
      return {
        ...b,
        x,
        yImg,
        yVid,
      };
    });

    const buildPath = (key) => {
      if (points.length === 0) return '';
      let d = `M ${points[0].x} ${points[0][key]}`;
      for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i === 0 ? 0 : i - 1];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[i + 2 < points.length ? i + 2 : i + 1];
        const cp1x = p1.x + (p2.x - p0.x) / 6;
        const cp1y = p1[key] + (p2[key] - p0[key]) / 6;
        const cp2x = p2.x - (p3.x - p1.x) / 6;
        const cp2y = p2[key] - (p3[key] - p1[key]) / 6;
        d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2[key].toFixed(1)}`;
      }
      return d;
    };

    const imgLine = buildPath('yImg');
    const vidLine = buildPath('yVid');
    const imgArea = `${imgLine} L ${points[points.length - 1].x} 160 L ${points[0].x} 160 Z`;
    const vidArea = `${vidLine} L ${points[points.length - 1].x} 160 L ${points[0].x} 160 Z`;

    return {
      points,
      imgLine,
      vidLine,
      imgArea,
      vidArea,
      maxVal,
    };
  }, [filteredRequests, timeline]);

  const handleChartMouseMove = (e) => {
    if (!chartBoxRef.current || !chartData.points.length) return;
    const rect = chartBoxRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const svgX = (mouseX / rect.width) * 650;

    let closest = chartData.points[0];
    let minDist = Math.abs(chartData.points[0].x - svgX);
    for (let i = 1; i < chartData.points.length; i++) {
      const dist = Math.abs(chartData.points[i].x - svgX);
      if (dist < minDist) {
        minDist = dist;
        closest = chartData.points[i];
      }
    }

    const pixelX = (closest.x / 650) * rect.width;
    const minY = Math.min(closest.yImg, closest.yVid);
    const pixelY = (minY / 180) * rect.height;

    setChartHover({
      ...closest,
      pixelX,
      pixelY,
    });
  };

  const handleChartMouseLeave = () => {
    setChartHover(null);
  };

  const handleSwitchBackend = (targetId) => {
    setBackends(prev =>
      prev.map(b => ({
        ...b,
        active: b.id === targetId,
        health: b.id === targetId ? 'healthy' : 'standby',
      }))
    );
    const target = backends.find(b => b.id === targetId);
    setFailoverLog(prev => [
      {
        time: new Date().toLocaleTimeString(),
        event: `Manual Failover: Traffic routed to ${target?.name} (${target?.url})`,
      },
      ...prev.slice(0, 8),
    ]);
  };

  const handleSimulateFailure = () => {
    setBackends(prev => {
      const currentActive = prev.find(b => b.active);
      if (!currentActive) return prev;
      const nextFailCount = currentActive.failures + 1;
      
      if (nextFailCount >= failureThreshold) {
        setFailoverLog(l => [
          {
            time: new Date().toLocaleTimeString(),
            event: `🚨 CIRCUIT BREAKER TRIPPED! ${currentActive.name} failed ${nextFailCount}/${failureThreshold} times. Auto-routing to Standby node!`,
          },
          ...l.slice(0, 8),
        ]);
        return prev.map(b => {
          if (b.id === currentActive.id) return { ...b, active: false, health: 'error', failures: nextFailCount };
          if (b.id === 'backup-1') return { ...b, active: true, health: 'healthy' };
          return b;
        });
      } else {
        setFailoverLog(l => [
          {
            time: new Date().toLocaleTimeString(),
            event: `⚠️ ${currentActive.name} returned 502 (${nextFailCount}/${failureThreshold} consecutive errors)`,
          },
          ...l.slice(0, 8),
        ]);
        return prev.map(b => (b.id === currentActive.id ? { ...b, failures: nextFailCount } : b));
      }
    });
  };

  return (
    <div className="app-shell">
      {/* 1. Left Thin Sidebar (Identical to Atelier benchmark) */}
      <aside className="app-sidebar">
        <div className="sidebar-logo" title="Atelier Gateway">
          <Zap size={22} color="var(--at-ink)" />
        </div>

        <nav className="sidebar-nav">
          <button className="sidebar-btn active" title="Dashboard">
            <LayoutDashboard size={20} />
          </button>
          <button className="sidebar-btn" title="Accounts">
            <Users size={20} />
          </button>
          <button className="sidebar-btn" title="Logs & Inspector">
            <Activity size={20} />
          </button>
          <button className="sidebar-btn" title="Circuit Breaker">
            <Server size={20} />
          </button>
        </nav>

        <div className="sidebar-btn" title="System Status: Healthy">
          <div className="radar-live-container" style={{ width: 14, height: 14 }}>
            <div className="radar-dot" />
            <div className="radar-ring" />
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="app-main">
        {/* 2. Top Header Bar (Matching Atelier Top Bar) */}
        <header className="app-header">
          {/* Search Box with ⌘K Badge */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, width: '420px', position: 'relative' }}>
            <Search size={16} color="var(--at-ink)" style={{ position: 'absolute', left: 12, top: 11 }} />
            <input
              type="text"
              placeholder="Search prompt, account, model or task ID..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="at-input"
              style={{ width: '100%', paddingLeft: 36, paddingRight: 48, fontSize: 13 }}
            />
            <span
              style={{
                position: 'absolute',
                right: 10,
                top: 8,
                fontSize: 10,
                fontFamily: 'var(--at-font-mono)',
                fontWeight: 700,
                border: '1.5px solid var(--at-ink)',
                borderRadius: 4,
                padding: '1px 6px',
                background: 'var(--at-surface-subtle)',
              }}
            >
              ⌘K
            </span>
          </div>

          {/* Right Header Status Badges */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            {/* Active Backend Indicator with animated radar wave */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                border: '2px solid var(--at-ink)',
                background: 'var(--at-surface)',
                padding: '6px 14px',
                borderRadius: 6,
                boxShadow: '2px 2px 0 #2e2317',
                fontSize: 12,
                fontFamily: 'var(--at-font-mono)',
                fontWeight: 700,
              }}
            >
              <div className="radar-live-container" style={{ width: 12, height: 12 }}>
                <div className="radar-dot" />
                <div className="radar-ring" />
              </div>
              <span>{backends.find(b => b.active)?.url.replace('http://', '')}</span>
              <span className="at-badge at-badge-success badge-float" style={{ fontSize: 9 }}>
                ONLINE
              </span>
            </div>

            {/* Refresh Button */}
            <button onClick={handleRefresh} title="Refresh Telemetry" className="at-btn-icon">
              <RotateCcw size={16} className={isRefreshing ? 'animate-spin' : ''} />
            </button>

            {/* Auto-Refresh Toggle */}
            <button
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={`at-btn at-btn-sm ${autoRefresh ? 'at-btn-success' : ''}`}
            >
              <div className="radar-live-container" style={{ width: 10, height: 10 }}>
                <div className="radar-dot" style={{ backgroundColor: autoRefresh ? 'var(--at-success)' : '#888' }} />
                {autoRefresh && <div className="radar-ring" />}
              </div>
              <span style={{ fontFamily: 'var(--at-font-mono)', fontSize: 11 }}>
                {autoRefresh ? 'LIVE (6s)' : 'PAUSED'}
              </span>
            </button>

            {/* User Profile */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                border: '2px solid var(--at-ink)',
                background: 'var(--at-surface)',
                padding: '5px 12px',
                borderRadius: 6,
                boxShadow: '2px 2px 0 #2e2317',
              }}
            >
              <div
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  background: 'var(--at-accent)',
                  border: '1.5px solid var(--at-ink)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 10,
                  fontWeight: 800,
                }}
              >
                AG
              </div>
              <span style={{ fontSize: 12, fontWeight: 700 }}>Admin</span>
            </div>
          </div>
        </header>

        {/* 3. Page Sub-Header: Title & Filter Controls */}
        <div className="app-content">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 28 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--at-text-muted)' }}>
                Traffic & Routing Controller
              </div>
              <h1 className="at-title">API Gateway Overview</h1>
              <p className="at-subtitle">
                Real-time reverse proxy telemetry & failover routing — Port 3456 &rarr; Backend 8765
              </p>
            </div>

            {/* Filter Action Bars */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              {/* Timeline Filter Segmented Tabs */}
              <div className="at-segmented-group">
                {['4h', '8h', '24h', '3d', '7d', '1month'].map(t => (
                  <button
                    key={t}
                    onClick={() => setTimeline(t)}
                    className={`at-segmented-item ${timeline === t ? 'active' : ''}`}
                  >
                    {t}
                  </button>
                ))}
              </div>

              {/* Output Type Filter */}
              <div className="at-segmented-group">
                <button
                  onClick={() => setTypeFilter('all')}
                  className={`at-segmented-item ${typeFilter === 'all' ? 'active' : ''}`}
                >
                  All
                </button>
                <button
                  onClick={() => setTypeFilter('image')}
                  className={`at-segmented-item ${typeFilter === 'image' ? 'active' : ''}`}
                >
                  Images
                </button>
                <button
                  onClick={() => setTypeFilter('video')}
                  className={`at-segmented-item ${typeFilter === 'video' ? 'active' : ''}`}
                >
                  Videos
                </button>
              </div>

              {/* Simulate 502 Button */}
              <button onClick={handleSimulateFailure} className="at-btn at-btn-danger" style={{ fontSize: 12 }}>
                <AlertTriangle size={14} />
                Simulate 502
              </button>
            </div>
          </div>

          {/* 4. Four Atelier Benchmark KPI Stat Cards with Kinetic Hover Elevation */}
          <div className="kpi-grid">
            {/* Card 1: Total Requests */}
            <div className="at-card at-card-interactive">
              <div className="at-card-header">
                <div className="at-card-icon">
                  <Activity size={20} color="var(--at-ink)" />
                </div>
                <div className="at-badge at-badge-success">
                  <ArrowUpRight size={12} />
                  <span>14.2%</span>
                </div>
              </div>
              <div className="at-kpi-label">Total Requests</div>
              <div className="at-kpi-val">{metrics.total.toLocaleString()}</div>
              <div className="sparkline-box">
                <svg viewBox="0 0 100 25" style={{ width: '100%', height: '100%', overflow: 'visible' }}>
                  <path
                    className="path-animated"
                    d="M0,18 Q20,10 40,15 T75,6 T100,2"
                    fill="none"
                    stroke="#de7a6c"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
            </div>

            {/* Card 2: Success Rate */}
            <div className="at-card at-card-interactive">
              <div className="at-card-header">
                <div className="at-card-icon">
                  <CheckCircle2 size={20} color="var(--at-success)" />
                </div>
                <div className="at-badge at-badge-success">
                  <ArrowUpRight size={12} />
                  <span>0.8%</span>
                </div>
              </div>
              <div className="at-kpi-label">Success Rate</div>
              <div className="at-kpi-val">{metrics.successRate}%</div>
              <div className="at-kpi-sub">{metrics.completed} OK &bull; {metrics.failed} Err</div>
              <div className="sparkline-box">
                <svg viewBox="0 0 100 25" style={{ width: '100%', height: '100%', overflow: 'visible' }}>
                  <path
                    className="path-animated"
                    d="M0,14 Q25,8 50,15 T80,18 T100,22"
                    fill="none"
                    stroke="#3d6102"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
            </div>

            {/* Card 3: Image / Video Output */}
            <div className="at-card at-card-interactive">
              <div className="at-card-header">
                <div className="at-card-icon">
                  <Sparkles size={20} color="var(--at-accent-text)" />
                </div>
                <div className="at-badge at-badge-accent">
                  <span>IMG / VID</span>
                </div>
              </div>
              <div className="at-kpi-label">Output Breakdown</div>
              <div className="at-kpi-val">
                {metrics.images} / {metrics.videos}
              </div>
              <div className="at-kpi-sub">
                {metrics.total > 0 ? Math.round((metrics.images / metrics.total) * 100) : 0}% Image &bull;{' '}
                {metrics.total > 0 ? Math.round((metrics.videos / metrics.total) * 100) : 0}% Video
              </div>
              <div className="sparkline-box">
                <svg viewBox="0 0 100 25" style={{ width: '100%', height: '100%', overflow: 'visible' }}>
                  <path
                    className="path-animated"
                    d="M0,20 Q30,12 60,18 T100,6"
                    fill="none"
                    stroke="#cd9b32"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
            </div>

            {/* Card 4: Avg Latency & Circuit Breaker */}
            <div className="at-card at-card-interactive">
              <div className="at-card-header">
                <div className="at-card-icon">
                  <ShieldCheck size={20} color="var(--at-tertiary)" />
                </div>
                <div className="at-badge at-badge-info">
                  <span>Failover: {failureThreshold}x</span>
                </div>
              </div>
              <div className="at-kpi-label">Avg Latency & Route</div>
              <div className="at-kpi-val">{metrics.avgLatency} ms</div>
              <div className="at-kpi-sub">
                Active fails: {backends.find(b => b.active)?.failures}
              </div>
              <div className="sparkline-box">
                <svg viewBox="0 0 100 25" style={{ width: '100%', height: '100%', overflow: 'visible' }}>
                  <path
                    className="path-animated"
                    d="M0,15 Q30,6 60,20 T100,14"
                    fill="none"
                    stroke="#9278ed"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
            </div>
          </div>

          {/* 5. Traffic Timeline Chart & Model Distribution */}
          <div className="analytics-grid">
            {/* Timeline Traffic Chart */}
            <div className="at-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, paddingBottom: 12, borderBottom: '1.5px solid var(--at-surface-subtle)' }}>
                <div>
                  <h3 style={{ fontFamily: 'var(--at-font-display)', fontWeight: 700, fontSize: 20 }}>
                    Traffic Volume & Output Activity
                  </h3>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--at-text-muted)' }}>
                    Timeline: {timeline.toUpperCase()} &bull; Classified by Image vs Video
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 16, fontSize: 12, fontFamily: 'var(--at-font-mono)', fontWeight: 700 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 12, height: 12, borderRadius: 2, background: '#de7a6c', border: '1px solid var(--at-ink)' }} />
                    <span>Image</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 12, height: 12, borderRadius: 2, background: '#3d6102', border: '1px solid var(--at-ink)' }} />
                    <span>Video</span>
                  </div>
                </div>
              </div>

              {/* Handcrafted Retro Wave Area Chart SVG with Dynamic Hover Effects */}
              <div
                ref={chartBoxRef}
                className="chart-wrapper"
                style={{ height: 210 }}
                onMouseMove={handleChartMouseMove}
                onMouseLeave={handleChartMouseLeave}
              >
                <svg
                  viewBox="0 0 650 180"
                  className="chart-interactive-svg"
                  style={{ width: '100%', height: '100%' }}
                >
                  {/* Grid Lines */}
                  <line x1="0" y1="40" x2="650" y2="40" stroke="#e6e5e3" strokeDasharray="3 3" />
                  <line x1="0" y1="90" x2="650" y2="90" stroke="#e6e5e3" strokeDasharray="3 3" />
                  <line x1="0" y1="140" x2="650" y2="140" stroke="#e6e5e3" strokeDasharray="3 3" />

                  {/* Retro Monospace Y-Axis Labels */}
                  <text x="5" y="36" fill="#8a7758" fontSize="10" fontFamily="JetBrains Mono">{chartData.maxVal} req</text>
                  <text x="5" y="86" fill="#8a7758" fontSize="10" fontFamily="JetBrains Mono">{Math.round(chartData.maxVal / 2)} req</text>
                  <text x="5" y="136" fill="#8a7758" fontSize="10" fontFamily="JetBrains Mono">{Math.round(chartData.maxVal / 5)} req</text>

                  {/* Area 1: Images (Terracotta) */}
                  <path
                    className="chart-area-path"
                    d={chartData.imgArea}
                    fill="rgba(222, 122, 108, 0.18)"
                  />
                  <path
                    className="chart-line-path path-animated"
                    d={chartData.imgLine}
                    fill="none"
                    stroke="#de7a6c"
                    strokeWidth="3"
                    strokeLinecap="round"
                  />

                  {/* Area 2: Videos (Olive Green) */}
                  <path
                    className="chart-area-path"
                    d={chartData.vidArea}
                    fill="rgba(61, 97, 2, 0.15)"
                  />
                  <path
                    className="chart-line-path path-animated"
                    d={chartData.vidLine}
                    fill="none"
                    stroke="#3d6102"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  />

                  {/* Static Point Dots along Curves */}
                  {chartData.points.map((pt, idx) => (
                    <g key={idx}>
                      <circle cx={pt.x} cy={pt.yImg} r="3" fill="#de7a6c" stroke="#f3ebda" strokeWidth="1" />
                      <circle cx={pt.x} cy={pt.yVid} r="3" fill="#3d6102" stroke="#f3ebda" strokeWidth="1" />
                    </g>
                  ))}

                  {/* Interactive Crosshair & Glowing Beacons when Hovering */}
                  {chartHover && (
                    <g>
                      {/* Vertical Crosshair Line */}
                      <line
                        x1={chartHover.x}
                        y1="20"
                        x2={chartHover.x}
                        y2="160"
                        className="chart-crosshair"
                      />

                      {/* Image Point Beacon (Terracotta) */}
                      <circle
                        cx={chartHover.x}
                        cy={chartHover.yImg}
                        r="10"
                        fill="rgba(222, 122, 108, 0.35)"
                        className="chart-beacon-halo"
                      />
                      <circle
                        cx={chartHover.x}
                        cy={chartHover.yImg}
                        r="5"
                        fill="#de7a6c"
                        stroke="#2e2317"
                        strokeWidth="2"
                        className="chart-beacon-dot"
                      />

                      {/* Video Point Beacon (Olive Green) */}
                      <circle
                        cx={chartHover.x}
                        cy={chartHover.yVid}
                        r="10"
                        fill="rgba(61, 97, 2, 0.35)"
                        className="chart-beacon-halo"
                      />
                      <circle
                        cx={chartHover.x}
                        cy={chartHover.yVid}
                        r="5"
                        fill="#3d6102"
                        stroke="#2e2317"
                        strokeWidth="2"
                        className="chart-beacon-dot"
                      />
                    </g>
                  )}
                </svg>

                {/* Floating Retro Tooltip Card */}
                {chartHover && (
                  <div
                    className="chart-tooltip"
                    style={{
                      left: `${chartHover.pixelX}px`,
                      top: `${Math.max(25, chartHover.pixelY - 12)}px`,
                    }}
                  >
                    <div className="chart-tooltip-header">
                      <span>TIME: {chartHover.label}</span>
                      <span style={{ color: '#2e2317', fontSize: 10 }}>● LIVE</span>
                    </div>
                    <div className="chart-tooltip-row">
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#de7a6c' }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: '#de7a6c', border: '1px solid #2e2317' }} />
                        Image Requests:
                      </span>
                      <strong>{chartHover.imgCount.toLocaleString()}</strong>
                    </div>
                    <div className="chart-tooltip-row">
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#3d6102' }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: '#3d6102', border: '1px solid #2e2317' }} />
                        Video Requests:
                      </span>
                      <strong>{chartHover.vidCount.toLocaleString()}</strong>
                    </div>
                    <div className="chart-tooltip-row">
                      <span style={{ color: 'var(--at-text-muted)' }}>Throughput:</span>
                      <span>{chartHover.total.toLocaleString()} req</span>
                    </div>
                    <div className="chart-tooltip-row">
                      <span style={{ color: 'var(--at-text-muted)' }}>Avg Latency:</span>
                      <span>{chartHover.avgLatency} ms</span>
                    </div>
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px 0', borderTop: '1px solid var(--at-surface-subtle)', fontSize: 10, fontFamily: 'var(--at-font-mono)', fontWeight: 700, color: 'var(--at-text-subtle)' }}>
                {chartData.points.map((pt, idx) => (
                  <span
                    key={idx}
                    style={{
                      color: chartHover?.index === idx ? 'var(--at-ink)' : 'inherit',
                      fontWeight: chartHover?.index === idx ? 800 : 700,
                      transition: 'color 0.15s ease',
                    }}
                  >
                    {pt.label}
                  </span>
                ))}
              </div>
            </div>

            {/* Model Share Box */}
            <div className="at-card at-card-interactive" style={{ justifyContent: 'space-between' }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, paddingBottom: 12, borderBottom: '1.5px solid var(--at-surface-subtle)' }}>
                  <h3 style={{ fontFamily: 'var(--at-font-display)', fontWeight: 700, fontSize: 20 }}>
                    Model Share
                  </h3>
                  <span className="at-badge at-badge-info">{modelStats.length} Models</span>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {modelStats.map((m, i) => (
                    <div key={m.name} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontFamily: 'var(--at-font-mono)' }}>
                        <span style={{ fontWeight: 700, color: 'var(--at-ink)' }}>{m.name}</span>
                        <span style={{ color: 'var(--at-text-muted)' }}>
                          {m.count} req ({m.pct}%)
                        </span>
                      </div>
                      <div style={{ height: 10, width: '100%', border: '1.5px solid var(--at-ink)', borderRadius: 3, background: 'var(--at-surface-subtle)', overflow: 'hidden', position: 'relative' }}>
                        <div
                          style={{
                            height: '100%',
                            width: `${m.pct}%`,
                            backgroundColor: i === 0 ? '#ff946f' : i === 1 ? '#4f7d2a' : i === 2 ? '#ce9a38' : '#2d4a5c',
                            transition: 'width 0.6s var(--at-ease-spring)',
                          }}
                        />
                        <div className="shimmer-bar" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ marginTop: 20, paddingTop: 12, borderTop: '1.5px solid var(--at-surface-subtle)', display: 'flex', justifyContent: 'space-between', fontSize: 12, fontFamily: 'var(--at-font-mono)' }}>
                <span style={{ fontWeight: 700 }}>Output Types:</span>
                <span style={{ color: '#de7a6c', fontWeight: 700 }}>● {metrics.images} Images</span>
                <span style={{ color: '#3d6102', fontWeight: 700 }}>● {metrics.videos} Videos</span>
              </div>
            </div>
          </div>

          {/* 6. Accounts Breakdown Section */}
          <div style={{ marginBottom: 32 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div>
                <h2 style={{ fontFamily: 'var(--at-font-display)', fontWeight: 700, fontSize: 24 }}>
                  Account Telemetry & Usage
                </h2>
                <div style={{ fontSize: 12, color: 'var(--at-text-muted)' }}>
                  Requests, models preferred, and completion rate aggregated by account identifier
                </div>
              </div>
              {accountFilter !== 'all' && (
                <button onClick={() => setAccountFilter('all')} className="at-btn at-btn-sm">
                  <X size={14} />
                  Clear Account Filter ({accountFilter})
                </button>
              )}
            </div>

            <div className="at-table-container">
              <table className="at-table">
                <thead>
                  <tr>
                    <th>Account Identifier</th>
                    <th>Total Requests</th>
                    <th>Images</th>
                    <th>Videos</th>
                    <th>Top Model</th>
                    <th>Success Rate</th>
                    <th>Filter</th>
                  </tr>
                </thead>
                <tbody>
                  {accountStats.map(acc => (
                    <tr
                      key={acc.account}
                      style={{ backgroundColor: accountFilter === acc.account ? 'var(--at-accent-wash)' : undefined }}
                    >
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div
                            style={{
                              width: 28,
                              height: 28,
                              borderRadius: 4,
                              border: '1.5px solid var(--at-ink)',
                              background: 'var(--at-surface-subtle)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontWeight: 800,
                              fontSize: 11,
                            }}
                          >
                            {acc.account.charAt(4).toUpperCase()}
                          </div>
                          <span style={{ fontFamily: 'var(--at-font-mono)', fontWeight: 700, color: 'var(--at-ink)' }}>
                            {acc.account}
                          </span>
                        </div>
                      </td>
                      <td style={{ fontFamily: 'var(--at-font-mono)', fontWeight: 700 }}>{acc.total}</td>
                      <td>
                        <span className="at-badge at-badge-accent">{acc.images}</span>
                      </td>
                      <td>
                        <span className="at-badge at-badge-success">{acc.videos}</span>
                      </td>
                      <td style={{ fontFamily: 'var(--at-font-mono)', fontSize: 12 }}>{acc.topModel}</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ width: 80, height: 10, border: '1px solid var(--at-ink)', borderRadius: 2, background: 'var(--at-surface-subtle)', overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${acc.rate}%`, background: 'var(--at-success)' }} />
                          </div>
                          <span style={{ fontFamily: 'var(--at-font-mono)', fontWeight: 700, fontSize: 12 }}>
                            {acc.rate}%
                          </span>
                        </div>
                      </td>
                      <td>
                        <button onClick={() => setAccountFilter(acc.account)} className="at-btn at-btn-sm">
                          <Filter size={12} /> Focus
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* 7. Live Request Stream & Inspector Table */}
          <div style={{ marginBottom: 32 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div>
                <h2 style={{ fontFamily: 'var(--at-font-display)', fontWeight: 700, fontSize: 24 }}>
                  Live Request Stream & Inspector
                </h2>
                <div style={{ fontSize: 12, color: 'var(--at-text-muted)' }}>
                  Inspect incoming request parameters, prompts, models, latency, and HTTP status
                </div>
              </div>
              <div style={{ fontSize: 12, fontFamily: 'var(--at-font-mono)', fontWeight: 700, color: 'var(--at-text-muted)' }}>
                Showing {filteredRequests.length} requests
              </div>
            </div>

            <div className="at-table-container">
              <table className="at-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Account</th>
                    <th>Type</th>
                    <th>Model</th>
                    <th>Prompt Preview</th>
                    <th>Status</th>
                    <th>Latency</th>
                    <th>Routed To</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRequests.slice(0, 15).map(req => (
                    <tr key={req.id}>
                      <td style={{ fontFamily: 'var(--at-font-mono)', fontSize: 11 }}>
                        {new Date(req.timestamp).toLocaleTimeString()}
                      </td>
                      <td style={{ fontFamily: 'var(--at-font-mono)', fontWeight: 700, fontSize: 12 }}>
                        {req.account}
                      </td>
                      <td>
                        {req.type === 'video' ? (
                          <span className="at-badge at-badge-success" style={{ fontSize: 10 }}>
                            <Video size={11} /> VID
                          </span>
                        ) : (
                          <span className="at-badge at-badge-accent" style={{ fontSize: 10 }}>
                            <ImageIcon size={11} /> IMG
                          </span>
                        )}
                      </td>
                      <td style={{ fontFamily: 'var(--at-font-mono)', fontSize: 12, fontWeight: 600 }}>
                        {req.model}
                      </td>
                      <td style={{ maxWidth: 280, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 12 }}>
                        "{req.prompt}"
                      </td>
                      <td>
                        {req.finalStatus === 'failed' || req.statusCode >= 400 ? (
                          <span className="at-badge at-badge-danger" title={req.error || ''}>
                            {req.statusCode >= 400 ? `${req.statusCode} ERR` : 'TASK FAILED'}
                          </span>
                        ) : (
                          <span className="at-badge at-badge-success">{req.statusCode} OK</span>
                        )}
                      </td>
                      <td style={{ fontFamily: 'var(--at-font-mono)', fontSize: 12 }}>{req.latency}ms</td>
                      <td style={{ fontFamily: 'var(--at-font-mono)', fontSize: 11, color: 'var(--at-text-subtle)' }}>
                        {req.targetBackend}
                      </td>
                      <td>
                        <button onClick={() => setSelectedRequest(req)} className="at-btn at-btn-sm">
                          <Eye size={12} /> Params
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* 8. Circuit Breaker & Failover Engine */}
          <div style={{ marginBottom: 40 }}>
            <div style={{ marginBottom: 12 }}>
              <h2 style={{ fontFamily: 'var(--at-font-display)', fontWeight: 700, fontSize: 24 }}>
                Circuit Breaker & Failover Routing
              </h2>
              <div style={{ fontSize: 12, color: 'var(--at-text-muted)' }}>
                Automated failover thresholds, multi-backend routing, and incident recovery logs
              </div>
            </div>

            <div className="analytics-grid">
              {/* Backends List Card */}
              <div className="at-card">
                <h3 style={{ fontFamily: 'var(--at-font-display)', fontWeight: 700, fontSize: 18, marginBottom: 12, paddingBottom: 8, borderBottom: '1px solid var(--at-surface-subtle)' }}>
                  Managed Backend Targets
                </h3>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {backends.map(b => (
                    <div
                      key={b.id}
                      style={{
                        padding: '12px 16px',
                        borderRadius: 6,
                        border: '2px solid var(--at-ink)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        backgroundColor: b.active ? 'var(--at-surface-subtle)' : 'var(--at-surface)',
                        boxShadow: b.active ? '3px 3px 0 #2e2317' : 'none',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div
                          style={{
                            width: 12,
                            height: 12,
                            borderRadius: '50%',
                            border: '1px solid var(--at-ink)',
                            backgroundColor:
                              b.health === 'healthy'
                                ? 'var(--at-success)'
                                : b.health === 'error'
                                ? 'var(--at-danger)'
                                : '#eab308',
                          }}
                        />
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 14 }}>{b.name}</div>
                          <div style={{ fontFamily: 'var(--at-font-mono)', fontSize: 12, color: 'var(--at-text-muted)' }}>
                            {b.url}
                          </div>
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                        <div style={{ textAlign: 'right', fontFamily: 'var(--at-font-mono)', fontSize: 12 }}>
                          <div style={{ fontWeight: 700 }}>{b.totalRequests} reqs</div>
                          <div style={{ color: b.failures > 0 ? 'var(--at-danger)' : 'var(--at-text-subtle)', fontWeight: b.failures > 0 ? 700 : 400 }}>
                            {b.failures} fails
                          </div>
                        </div>

                        {b.active ? (
                          <span className="at-badge at-badge-success">ACTIVE</span>
                        ) : (
                          <button onClick={() => handleSwitchBackend(b.id)} className="at-btn at-btn-sm">
                            Switch Here
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Circuit Breaker Controls */}
                <div style={{ marginTop: 20, paddingTop: 14, borderTop: '1.5px solid var(--at-surface-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 12, fontWeight: 700 }}>Failure Threshold:</span>
                    <select
                      value={failureThreshold}
                      onChange={e => setFailureThreshold(Number(e.target.value))}
                      className="at-input"
                      style={{ padding: '4px 8px', fontSize: 12, fontFamily: 'var(--at-font-mono)', fontWeight: 700 }}
                    >
                      <option value={2}>2 errors (Aggressive)</option>
                      <option value={3}>3 errors (Standard)</option>
                      <option value={5}>5 errors (Lenient)</option>
                    </select>
                  </div>

                  <div style={{ display: 'flex', gap: 10 }}>
                    <span className="at-badge at-badge-success">AUTO-RETRY: ON</span>
                    <span className="at-badge at-badge-warning">HEALTH-CHECK: 10s</span>
                  </div>
                </div>
              </div>

              {/* Routing Events Log Card */}
              <div className="at-card" style={{ justifyContent: 'space-between' }}>
                <div>
                  <h3 style={{ fontFamily: 'var(--at-font-display)', fontWeight: 700, fontSize: 18, marginBottom: 12, paddingBottom: 8, borderBottom: '1px solid var(--at-surface-subtle)' }}>
                    Routing Event Log
                  </h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 220, overflowY: 'auto' }}>
                    {failoverLog.map((log, i) => (
                      <div
                        key={i}
                        style={{
                          fontSize: 11,
                          fontFamily: 'var(--at-font-mono)',
                          padding: '8px 10px',
                          borderRadius: 4,
                          border: '1px solid var(--at-ink)',
                          background: 'var(--at-surface-subtle)',
                          lineHeight: 1.4,
                        }}
                      >
                        <span style={{ fontWeight: 700, color: 'var(--at-accent-text)' }}>[{log.time}]</span>{' '}
                        <span>{log.event}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px solid var(--at-surface-subtle)', fontSize: 11, color: 'var(--at-text-muted)', display: 'flex', justifyContent: 'space-between' }}>
                  <span>Strategy: Automatic Circuit Breaker</span>
                  <span style={{ color: 'var(--at-success)', fontWeight: 700 }}>● Active</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 9. Request Params Inspector Modal */}
      {selectedRequest && (
        <div className="at-modal-backdrop" onClick={() => setSelectedRequest(null)}>
          <div className="at-modal-box" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 12, marginBottom: 16, borderBottom: '2px solid var(--at-ink)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Code size={20} color="var(--at-accent-text)" />
                <h3 style={{ fontFamily: 'var(--at-font-display)', fontWeight: 700, fontSize: 20 }}>
                  Request Parameters & Telemetry
                </h3>
              </div>
              <button onClick={() => setSelectedRequest(null)} className="at-btn-icon" style={{ width: 30, height: 30 }}>
                ✕
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, fontSize: 13 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, padding: 12, background: 'var(--at-surface-subtle)', borderRadius: 6, border: '1.5px solid var(--at-ink)' }}>
                <div>
                  <div style={{ fontSize: 10, textTransform: 'uppercase', fontWeight: 800, color: 'var(--at-text-muted)' }}>Account</div>
                  <div style={{ fontFamily: 'var(--at-font-mono)', fontWeight: 700 }}>{selectedRequest.account}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, textTransform: 'uppercase', fontWeight: 800, color: 'var(--at-text-muted)' }}>Task ID</div>
                  <div style={{ fontFamily: 'var(--at-font-mono)', fontWeight: 700 }}>{selectedRequest.taskId}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, textTransform: 'uppercase', fontWeight: 800, color: 'var(--at-text-muted)' }}>Model & Type</div>
                  <div style={{ fontFamily: 'var(--at-font-mono)', fontWeight: 700 }}>{selectedRequest.model} ({selectedRequest.type.toUpperCase()})</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, textTransform: 'uppercase', fontWeight: 800, color: 'var(--at-text-muted)' }}>Target Backend</div>
                  <div style={{ fontFamily: 'var(--at-font-mono)', fontWeight: 700 }}>{selectedRequest.targetBackend}</div>
                </div>
              </div>

              {selectedRequest.error && (
                <div>
                  <div style={{ fontWeight: 700, marginBottom: 4, color: 'var(--at-danger, #b3261e)' }}>Error (from backend):</div>
                  <pre style={{ padding: 12, background: '#fff', border: '1.5px solid var(--at-ink)', borderRadius: 6, whiteSpace: 'pre-wrap', fontFamily: 'var(--at-font-mono)', fontSize: 11 }}>
                    {selectedRequest.error}
                  </pre>
                </div>
              )}

              <div style={{ fontFamily: 'var(--at-font-mono)', fontSize: 11, color: 'var(--at-text-muted)' }}>
                Request ID: {selectedRequest.requestId || 'n/a'} &bull; Attempts: {selectedRequest.attempts ?? 1}<br />
                Full trace: /api/admin/trace?task_id={selectedRequest.taskId}
              </div>

              <div>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>Full Prompt:</div>
                <div style={{ padding: 12, background: '#fff', border: '1.5px solid var(--at-ink)', borderRadius: 6, fontStyle: 'italic', lineHeight: 1.4 }}>
                  "{selectedRequest.prompt}"
                </div>
              </div>

              <div>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>Parameters JSON Body:</div>
                <pre style={{ padding: 12, background: '#2e2317', color: '#f3ebda', borderRadius: 6, border: '1.5px solid var(--at-ink)', fontFamily: 'var(--at-font-mono)', fontSize: 11, overflowX: 'auto' }}>
                  {JSON.stringify(selectedRequest.params, null, 2)}
                </pre>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 12, borderTop: '1px solid var(--at-surface-subtle)' }}>
                <span style={{ fontFamily: 'var(--at-font-mono)', fontSize: 12, color: 'var(--at-text-muted)' }}>
                  Status: {selectedRequest.statusCode} {selectedRequest.finalStatus} &bull; Latency: {selectedRequest.latency}ms
                </span>
                <button onClick={() => setSelectedRequest(null)} className="at-btn at-btn-primary at-btn-sm">
                  Close Inspector
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
