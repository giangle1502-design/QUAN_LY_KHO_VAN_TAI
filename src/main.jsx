import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { configured } from './firebase';
import { AppProvider } from './context/AppContext';
import App from './App';
import './styles.css';

const root = ReactDOM.createRoot(document.getElementById('root'));
if (!configured) {
  root.render(
    <div className="center">
      <div className="card narrow">
        <h2>Chưa cấu hình Firebase</h2>
        <p>Khai báo các biến VITE_FIREBASE_* (xem README mục 1) rồi build lại.</p>
      </div>
    </div>
  );
} else {
  root.render(
    <React.StrictMode>
      <BrowserRouter>
        <AppProvider>
          <App />
        </AppProvider>
      </BrowserRouter>
    </React.StrictMode>
  );
}
