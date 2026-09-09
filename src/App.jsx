import './App.css';
import { useState, useEffect } from 'react';
import io from 'socket.io-client';
import axios from 'axios';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

let deviceId = localStorage.getItem('mfa_device_id');
if (!deviceId) {
  deviceId = 'device_' + Math.random().toString(36).substring(2, 9);
  localStorage.setItem('mfa_device_id', deviceId);
}

export default function App() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [user, setUser] = useState(null);
  const [socket, setSocket] = useState(null);

  const [mfaWaiting, setMfaWaiting] = useState(false);
  const [mfaRequest, setMfaRequest] = useState(null);
  const [statusMsg, setStatusMsg] = useState({ text: '', type: '' });

  const [hasPasskey, setHasPasskey] = useState(false);

  useEffect(() => {
    const newSocket = io(API_URL, {
      transports: ['websocket', 'polling'],
      withCredentials: true
    });
    setSocket(newSocket);

    const savedUserId = localStorage.getItem('mfa_user_id');
    if (savedUserId) {
      newSocket.emit('join_user_room', savedUserId);
    }

    newSocket.on('mfa_approval_request', (data) => {
      setMfaRequest(data);
    });

    newSocket.on('mfa_result', (result) => {
      setMfaWaiting(false);
      if (result.status === 'APPROVED') {
        setUser({ token: result.token });
        setStatusMsg({ text: '✅ Phê duyệt thành công! Đã đăng nhập.', type: 'success' });
      } else {
        setStatusMsg({ text: '❌ Yêu cầu đăng nhập bị từ chối.', type: 'error' });
      }
    });

    return () => newSocket.close();
  }, []);

  const checkPasskeyStatus = async (userId) => {
    try {
      const res = await axios.get(`${API_URL}/api/passkey/status/${userId}`);
      setHasPasskey(res.data.hasPasskey);
    } catch (err) {
      const registered = localStorage.getItem(`passkey_registered_${userId}`);
      setHasPasskey(!!registered);
    }
  };

  const handleAuth = async (e) => {
    e.preventDefault();
    setStatusMsg({ text: '', type: '' });

    try {
      if (isRegistering) {
        await axios.post(`${API_URL}/api/auth/register`, {
          username,
          password,
          deviceId,
          deviceName: 'Trình duyệt Web'
        });

        setStatusMsg({ text: '✅ Đăng ký thành công! Vui lòng đăng nhập.', type: 'success' });
        setIsRegistering(false);
      } else {
        const res = await axios.post(`${API_URL}/api/auth/login`, {
          username,
          password,
          deviceId
        });

        const data = res.data;

        if (data.status === 'SUCCESS') {
          setUser({ token: data.token, userId: data.userId, username, trustScore: data.trustScore ?? 100 });
          setStatusMsg({ text: '🎉 Đăng nhập thành công!', type: 'success' });

          if (data.userId) {
            localStorage.setItem('mfa_user_id', data.userId);
            if (socket) socket.emit('join_user_room', data.userId);
            checkPasskeyStatus(data.userId);
          }
        } 
        else if (data.status === 'MFA_REQUIRED' && data.action === 'REQUIRE_CROSS_DEVICE_APPROVAL') {
          setMfaWaiting(true);
          setStatusMsg({ text: '⚠️ Thiết bị lạ! Đang gửi yêu cầu phê duyệt tới thiết bị tin cậy...', type: 'warning' });
          if (socket && data.userId) socket.emit('join_user_room', data.userId);
        } 
        else if (data.status === 'MFA_REQUIRED' && data.action === 'REQUIRE_PASSKEY_BIOMETRIC') {
          setStatusMsg({ text: '🔑 Điểm tin cậy thấp. Yêu cầu quét Passkey...', type: 'warning' });
          await handlePasskeyLogin(data.userId);
        }
      }
    } catch (err) {
      setStatusMsg({ text: '❌ ' + (err.response?.data?.error || 'Lỗi kết nối máy chủ'), type: 'error' });
    }
  };

  const handlePasskeyLogin = async (userId) => {
    try {
      const optsRes = await axios.post(`${API_URL}/api/passkey/login-options`, { userId });
      const asseResp = await startAuthentication({ optionsJSON: optsRes.data });

      const verifyRes = await axios.post(`${API_URL}/api/passkey/login-verify`, {
        userId,
        credentialResponse: asseResp
      });

      if (verifyRes.data.status === 'SUCCESS') {
        setUser({ token: verifyRes.data.token, userId, username });
        setStatusMsg({ text: '🎉 Xác thực sinh trắc học thành công!', type: 'success' });
        localStorage.setItem('mfa_user_id', userId);
        checkPasskeyStatus(userId);
      }
    } catch (err) {
      setStatusMsg({ text: '❌ Lỗi Passkey: ' + (err.response?.data?.error || err.message), type: 'error' });
    }
  };

  const handleRegisterPasskey = async () => {
    if (!user?.userId) return;
    try {
      const optsRes = await axios.post(`${API_URL}/api/passkey/register-options`, { userId: user.userId });
      const attResp = await startRegistration({ optionsJSON: optsRes.data });

      const verifyRes = await axios.post(`${API_URL}/api/passkey/register-verify`, {
        userId: user.userId,
        credentialResponse: attResp
      });

      alert(verifyRes.data.message || 'Cài đặt Passkey thành công!');
      setHasPasskey(true);
      localStorage.setItem(`passkey_registered_${user.userId}`, 'true');
    } catch (err) {
      alert('Lỗi đăng ký Passkey: ' + (err.response?.data?.error || err.message));
    }
  };

  const handleApprove = async (approved) => {
    if (!approved) {
      sendApproveRequest(false);
      return;
    }

    if (window.PublicKeyCredential) {
      try {
        const challenge = new Uint8Array(32);
        window.crypto.getRandomValues(challenge);

        await navigator.credentials.get({
          publicKey: { challenge, timeout: 60000, userVerification: 'preferred' }
        });

        sendApproveRequest(true);
      } catch (bioErr) {
        if (confirm('Xác thực sinh trắc học không hoàn tất. Bạn vẫn muốn Phê duyệt chứ?')) {
          sendApproveRequest(true);
        }
      }
    } else {
      sendApproveRequest(true);
    }
  };

  const sendApproveRequest = async (approved) => {
    try {
      await axios.post(`${API_URL}/api/auth/approve-mfa`, {
        sessionId: mfaRequest.sessionId,
        approved
      });
      setMfaRequest(null);
      setStatusMsg({ text: approved ? '✅ Đã phê duyệt truy cập!' : '⛔ Đã từ chối.', type: approved ? 'success' : 'error' });
    } catch (err) {
      alert('Lỗi phê duyệt: ' + err.message);
    }
  };

  const handleLogout = () => {
    setUser(null);
    setMfaWaiting(false);
    setHasPasskey(false);
    localStorage.removeItem('mfa_user_id');
    setStatusMsg({ text: '', type: '' });
  };

  return (
    <div className="mfa-container">
      <h2 className="mfa-title">🛡️ Adaptive MFA</h2>
      <div className="device-badge">
        Thiết bị: <code>{deviceId}</code>
      </div>

      {statusMsg.text && (
        <div className={`status-box ${statusMsg.type}`}>
          {statusMsg.text}
        </div>
      )}

      {mfaRequest && (
        <div className="mfa-alert">
          <h4 style={{ color: '#ef4444', margin: '0 0 8px 0' }}>🚨 PHÊ DUYỆT TRUY CẬP</h4>
          <p style={{ fontSize: '13px', margin: '0 0 12px 0' }}>{mfaRequest.message}</p>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button className="btn-primary" style={{ background: '#10b981' }} onClick={() => handleApprove(true)}>Phê duyệt</button>
            <button className="btn-danger" onClick={() => handleApprove(false)}>Từ chối</button>
          </div>
        </div>
      )}

      {user ? (
        <div className="dashboard-card">
          <div className="badge-trust">
            🛡️ Trust Score: {user.trustScore ?? 100} / 100
          </div>
          <h3 style={{ margin: '0 0 20px 0' }}>Xin chào, {user.username || 'User'}! 👋</h3>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {!hasPasskey && (
              <button className="btn-secondary" onClick={handleRegisterPasskey}>
                🔑 Đăng ký Vân Tay / Passkey
              </button>
            )}

            <button className="btn-danger" onClick={handleLogout}>
              Đăng xuất
            </button>
          </div>
        </div>
      ) : mfaWaiting ? (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <p style={{ fontSize: '16px', fontWeight: 600 }}>⏳ Đang chờ xác nhận...</p>
          <p style={{ fontSize: '13px', color: 'var(--text-sub)' }}>
            Vui lòng kiểm tra thiết bị đã đăng ký để bấm "Phê duyệt".
          </p>
        </div>
      ) : (
        <form onSubmit={handleAuth} className="form-group">
          <h3 style={{ margin: '0 0 8px 0', fontSize: '18px' }}>
            {isRegistering ? 'Tạo tài khoản mới' : 'Đăng nhập hệ thống'}
          </h3>
          <input
            type="text"
            className="input-field"
            placeholder="Tên đăng nhập"
            value={username}
            onChange={e => setUsername(e.target.value)}
            required
          />
          <input
            type="password"
            className="input-field"
            placeholder="Mật khẩu"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
          />

          <button type="submit" className="btn-primary">
            {isRegistering ? 'Đăng ký ngay' : 'Đăng nhập'}
          </button>

          <div className="toggle-link" onClick={() => setIsRegistering(!isRegistering)}>
            {isRegistering ? 'Đã có tài khoản? Đăng nhập' : 'Chưa có tài khoản? Đăng ký ngay'}
          </div>
        </form>
      )}
    </div>
  );
}