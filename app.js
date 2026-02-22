const fileInput = document.getElementById('fileInput');
const statusEl = document.getElementById('status');
const resultGrid = document.getElementById('resultGrid');
const basicData = document.getElementById('basicData');
const captureData = document.getElementById('captureData');
const astroData = document.getElementById('astroData');
const previewPanel = document.getElementById('previewPanel');
const preview = document.getElementById('preview');
const actions = document.getElementById('actions');
const exportJsonBtn = document.getElementById('exportJson');
const exportCsvBtn = document.getElementById('exportCsv');

let latestReport = null;
let latestFileName = 'report';

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => {
  if (!d || Number.isNaN(d.getTime())) return '未知';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const deg = (v, digits = 4) => (typeof v === 'number' ? `${v.toFixed(digits)}°` : '未知');
const num = (v, digits = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '未知');

function toRad(v) { return (v * Math.PI) / 180; }
function toDeg(v) { return (v * 180) / Math.PI; }

function gmst(date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const t = (jd - 2451545.0) / 36525;
  let s = 280.46061837 + 360.98564736629 * (jd - 2451545) + 0.000387933 * t * t - (t * t * t) / 38710000;
  s = ((s % 360) + 360) % 360;
  return s;
}

function calculateGalacticCenterAltAz(date, lat, lon) {
  const raHours = 17 + 45 / 60 + 40 / 3600;
  const dec = -29.0078;

  const lst = (gmst(date) + lon + 360) % 360;
  const ha = ((lst - raHours * 15 + 540) % 360) - 180;

  const latR = toRad(lat);
  const decR = toRad(dec);
  const haR = toRad(ha);

  const sinAlt = Math.sin(decR) * Math.sin(latR) + Math.cos(decR) * Math.cos(latR) * Math.cos(haR);
  const alt = Math.asin(sinAlt);

  const y = -Math.sin(haR);
  const x = Math.tan(decR) * Math.cos(latR) - Math.sin(latR) * Math.cos(haR);
  let az = toDeg(Math.atan2(y, x));
  az = (az + 360) % 360;

  return { altitude: toDeg(alt), azimuth: az, lst };
}

function row(key, value) {
  return `<dt>${key}</dt><dd>${value}</dd>`;
}

function render(target, data) {
  target.innerHTML = Object.entries(data)
    .map(([k, v]) => row(k, v ?? '未知'))
    .join('');
}

function toCsv(obj) {
  const flatten = (prefix, value, acc) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.entries(value).forEach(([k, v]) => flatten(prefix ? `${prefix}.${k}` : k, v, acc));
      return;
    }
    acc[prefix] = value;
  };

  const flat = {};
  flatten('', obj, flat);
  const headers = Object.keys(flat);
  const vals = headers.map((h) => `"${String(flat[h] ?? '').replace(/"/g, '""')}"`);
  return `${headers.join(',')}\n${vals.join(',')}\n`;
}

function download(content, type, filename) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  latestFileName = file.name.replace(/\.[^.]+$/, '') || 'report';
  statusEl.textContent = `正在读取：${file.name}`;

  try {
    if (file.type.startsWith('image/')) {
      preview.src = URL.createObjectURL(file);
      previewPanel.hidden = false;
    }

    const exif = await exifr.parse(file, {
      tiff: true,
      xmp: true,
      iptc: true,
      gps: true,
      ifd0: true,
      exif: true,
      interop: true,
      translateValues: true
    });

    if (!exif) {
      throw new Error('未读取到可用 EXIF。该格式可能不包含 EXIF 或浏览器端不支持该编码。');
    }

    const shotTime = exif.DateTimeOriginal || exif.CreateDate || exif.ModifyDate;
    const lat = exif.latitude;
    const lon = exif.longitude;
    const direction = exif.GPSImgDirection ?? exif.GPSDestBearing ?? exif.CameraElevationAngle;

    const basic = {
      文件名: file.name,
      文件大小: `${(file.size / 1024 / 1024).toFixed(2)} MB`,
      文件类型: file.type || '未知',
      宽度: exif.ExifImageWidth || exif.ImageWidth || '未知',
      高度: exif.ExifImageHeight || exif.ImageHeight || '未知',
      相机: [exif.Make, exif.Model].filter(Boolean).join(' ') || '未知',
      镜头: exif.LensModel || exif.LensInfo || '未知',
    };

    const capture = {
      拍摄时间: fmtDate(shotTime ? new Date(shotTime) : null),
      拍摄地点纬度: deg(lat),
      拍摄地点经度: deg(lon),
      海拔: exif.GPSAltitude ? `${num(exif.GPSAltitude)} m` : '未知',
      方位角: deg(direction),
      ISO: exif.ISO || exif.RecommendedExposureIndex || '未知',
      快门: exif.ExposureTime ? `${exif.ExposureTime}s` : '未知',
      光圈: exif.FNumber ? `f/${num(exif.FNumber, 1)}` : '未知',
      焦距: exif.FocalLength ? `${num(exif.FocalLength, 1)} mm` : '未知',
      白平衡: exif.WhiteBalance || '未知',
    };

    let astro = { 备注: '需要完整拍摄时间+GPS 经纬度才可计算天文参数。' };

    if (shotTime && typeof lat === 'number' && typeof lon === 'number' && window.SunCalc) {
      const t = new Date(shotTime);
      const sunPos = SunCalc.getPosition(t, lat, lon);
      const moonPos = SunCalc.getMoonPosition(t, lat, lon);
      const moonIll = SunCalc.getMoonIllumination(t);
      const times = SunCalc.getTimes(t, lat, lon);
      const gal = calculateGalacticCenterAltAz(t, lat, lon);

      astro = {
        太阳高度角: deg(toDeg(sunPos.altitude)),
        太阳方位角: deg((toDeg(sunPos.azimuth) + 180) % 360),
        月亮高度角: deg(toDeg(moonPos.altitude)),
        月亮方位角: deg((toDeg(moonPos.azimuth) + 180) % 360),
        月相亮度: `${num(moonIll.fraction * 100)}%`,
        本地恒星时: deg(gal.lst),
        银河中心高度角估算: deg(gal.altitude),
        银河中心方位角估算: deg(gal.azimuth),
        天文晨光开始: fmtDate(times.dawn),
        天文暮光结束: fmtDate(times.dusk),
      };
    }

    latestReport = { basic, capture, astro, rawExif: exif };
    render(basicData, basic);
    render(captureData, capture);
    render(astroData, astro);

    resultGrid.hidden = false;
    actions.hidden = false;
    statusEl.textContent = 'EXIF 与天文背景数据已生成，可导出。';
  } catch (err) {
    statusEl.textContent = `解析失败：${err.message}`;
    resultGrid.hidden = true;
    actions.hidden = true;
  }
});

exportJsonBtn.addEventListener('click', () => {
  if (!latestReport) return;
  download(JSON.stringify(latestReport, null, 2), 'application/json', `${latestFileName}-exif-report.json`);
});

exportCsvBtn.addEventListener('click', () => {
  if (!latestReport) return;
  download(toCsv(latestReport), 'text/csv;charset=utf-8', `${latestFileName}-exif-report.csv`);
});
