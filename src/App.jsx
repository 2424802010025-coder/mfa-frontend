import { useState, useEffect } from 'react';
import io from 'socket.io-client';
import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'https://mfa-backend-5ast.onrender.com';

// Lấy hoặc khởi tạo Device ID cố định cho trình duyệt này
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
  const [statusMsg, setStatusMsg] = useState('');

  useEffect(() => {
    // 1. Khởi tạo kết nối Socket.io
    const newSocket = io(API_URL);
    setSocket(newSocket);

    // 2. Khôi phục phòng Socket nếu đã từng đăng nhập trước đó (Giúp F5 không bị mất kết nối)
    const savedUserId = localStorage.getItem('mfa_user_id');
    if (savedUserId) {
      newSocket.emit('join_user_room', savedUserId);
    }

    // 3. Lắng nghe cảnh báo yêu cầu phê duyệt (Máy Tin Cậy)
    newSocket.on('mfa_approval_request', (data) => {
      setMfaRequest(data);
    });

    // 4. Lắng nghe kết quả phê duyệt Real-time (Máy Lạ)
    newSocket.on('mfa_result', (result) => {
      setMfaWaiting(false);
      if (result.status === 'APPROVED') {
        setUser({ token: result.token });
        setStatusMsg('✅ Phê duyệt thành công! Đã đăng nhập.');
      } else {
        setStatusMsg('❌ Yêu cầu đăng nhập bị từ chối.');
      }
    });

    return () => newSocket.close();
  }, []);

  const handleAuth = async (e) => {
    e.preventDefault();
    setStatusMsg('');
    const endpoint = isRegistering ? '/register' : '/login';

    try {
      const res = await axios.post(`${API_URL}${endpoint}`, {
        username,
        password,
        deviceId,
        deviceName: 'Trình duyệt Web'
      });

      if (isRegistering) {
        setStatusMsg('✅ Đăng ký thành công! Bạn có thể đăng nhập ngay.');
        setIsRegistering(false);
        return;
      }

      if (res.data.status === 'SUCCESS') {
        setUser({ token: res.data.token, userId: res.data.userId });
        setStatusMsg(`🎉 Đăng nhập thành công! (Trust Score: ${res.data.trustScore})`);
        
        if (res.data.userId) {
          localStorage.setItem('mfa_user_id', res.data.userId);
          if (socket) socket.emit('join_user_room', res.data.userId);
        }
      } else if (res.data.status === 'MFA_REQUIRED') {
        setMfaWaiting(true);
        setStatusMsg('⚠️ Thiết bị lạ! Đã gửi yêu cầu phê duyệt tới máy tin cậy.');
        if (socket) socket.emit('join_user_room', res.data.userId);
      }
    } catch (err) {
      setStatusMsg('❌ ' + (err.response?.data?.error || 'Lỗi kết nối máy chủ'));
    }
  };

  const handleApprove = async (approved) => {
    if (!approved) {
      sendApproveRequest(false);
      return;
    }

    // Bật xác thực Sinh trắc học (Windows Hello / Touch ID) có cơ chế Fallback
    if (window.PublicKeyCredential) {
      try {
        const challenge = new Uint8Array(32);
        window.crypto.getRandomValues(challenge);

        await navigator.credentials.get({
          publicKey: {
            challenge: challenge,
            timeout: 60000,
            userVerification: 'preferred'
          }
        });

        sendApproveRequest(true);
      } catch (bioErr) {
        console.warn("Xác thực sinh trắc học bỏ qua/lỗi:", bioErr);
        if (confirm('Xác thực sinh trắc học không thành công hoặc bị hủy. Bạn vẫn muốn Phê duyệt chứ?')) {
          sendApproveRequest(true);
        }
      }
    } else {
      sendApproveRequest(true);
    }
  };

  const sendApproveRequest = async (approved) => {
    try {
      await axios.post(`${API_URL}/approve-mfa`, {
        sessionId: mfaRequest.sessionId,
        approved
      });
      setMfaRequest(null);
      setStatusMsg(approved ? '✅ Đã phê duyệt cho thiết bị mới!' : '⛔ Đã từ chối.');
    } catch (err) {
      alert('Lỗi phê duyệt: ' + err.message);
    }
  };

  const handleLogout = () => {
    setUser(null);
    localStorage.removeItem('mfa_user_id');
  };

  return (
    <div style={{ padding: '30px', fontFamily: 'Arial, sans-serif', maxWidth: '450px', margin: '40px auto', border: '1px solid #ccc', borderRadius: '10px', boxShadow: '0 4px 10px rgba(0,0,0,0.1)' }}>
      <h2 style={{ textAlign: 'center' }}>🛡️ Adaptive MFA System</h2>
      <p style={{ fontSize: '12px', color: '#666' }}><b>Device ID hiện tại:</b> <code>{deviceId}</code></p>

      {statusMsg && (
        <div style={{ padding: '10px', background: '#eef', borderRadius: '5px', marginBottom: '15px', fontSize: '14px' }}>
          {statusMsg}
        </div>
      )}

      {/* Popup Cảnh báo Phê duyệt dành cho Máy Tin Cậy */}
      {mfaRequest && (
        <div style={{ border: '2px solid #ff4d4f', padding: '15px', borderRadius: '8px', background: '#fff2f0', marginBottom: '20px' }}>
          <h3 style={{ color: '#cf1322', marginTop: 0 }}>🚨 CẢNH BÁO XÁC THỰC!</h3>
          <p>{mfaRequest.message}</p>
          <p><small>Mã thiết bị yêu cầu: {mfaRequest.deviceId}</small></p>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button onClick={() => handleApprove(true)} style={{ flex: 1, background: '#52c41a', color: 'white', padding: '8px', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Phê duyệt</button>
            <button onClick={() => handleApprove(false)} style={{ flex: 1, background: '#ff4d4f', color: 'white', padding: '8px', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Từ chối</button>
          </div>
        </div>
      )}

      {user ? (
        <div style={{ background: '#f6ffed', border: '1px solid #b7eb8f', padding: '15px', borderRadius: '8px', textAlign: 'center' }}>
          <h3>🎉 Đã Đăng Nhập Thành Công!</h3>
          <p style={{ fontSize: '12px', wordBreak: 'break-all' }}><b>Token:</b> {user.token}</p>
          <button onClick={handleLogout} style={{ padding: '8px 15px', cursor: 'pointer' }}>Đăng xuất</button>
        </div>
      ) : mfaWaiting ? (
        <div style={{ textAlign: 'center', padding: '20px', border: '1px dashed #faad14', borderRadius: '8px' }}>
          <p style={{ fontSize: '16px' }}>⏳ <b>Đang chờ phê duyệt từ máy tin cậy...</b></p>
          <p style={{ fontSize: '13px', color: '#666' }}>Vui lòng mở ứng dụng trên thiết bị quen thuộc của bạn để bấm "Phê duyệt".</p>
        </div>
      ) : (
        <form onSubmit={handleAuth} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <h3>{isRegistering ? 'Đăng ký tài khoản' : 'Đăng nhập'}</h3>
          <input type="text" placeholder="Tên đăng nhập" value={username} onChange={e => setUsername(e.target.value)} required style={{ padding: '10px', borderRadius: '4px', border: '1px solid #ccc' }} />
          <input type="password" placeholder="Mật khẩu" value={password} onChange={e => setPassword(e.target.value)} required style={{ padding: '10px', borderRadius: '4px', border: '1px solid #ccc' }} />
          <button type="submit" style={{ padding: '10px', background: '#1890ff', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
            {isRegistering ? 'Tạo tài khoản' : 'Đăng nhập'}
          </button>
          <p style={{ cursor: 'pointer', color: '#1890ff', fontSize: '13px', textAlign: 'center', marginTop: '10px' }} onClick={() => setIsRegistering(!isRegistering)}>
            {isRegistering ? 'Đã có tài khoản? Đăng nhập' : 'Chưa có tài khoản? Đăng ký ngay'}
          </p>
        </form>
      )}
    </div>
  );
}