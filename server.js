const express = require('express');
const session = require('express-session');
const path = require('path');
const { initDatabase } = require('./db');

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const shopRoutes = require('./routes/shop');
const profileRoutes = require('./routes/profile');
const spinRoutes = require('./routes/spin');
const contactRoutes = require('./routes/contact');
const paymentRoutes = require('./routes/payment');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'mining-app-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    httpOnly: true
  }
}));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/shop', shopRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/spin', spinRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/admin', adminRoutes);

// Redirect root to login
app.get('/', (req, res) => {
  res.redirect('/login.html');
});

// Initialize DB then start server
(async () => {
  try {
    await initDatabase();
    app.listen(PORT, () => {
      console.log(`\n\u{1F680} Mining Website running at http://localhost:${PORT}`);
      console.log(`\u{1F4CB} Login:     http://localhost:${PORT}/login.html`);
      console.log(`\u{1F4CB} Register:  http://localhost:${PORT}/register.html`);
      console.log(`\u{1F4CB} Dashboard: http://localhost:${PORT}/dashboard.html`);
      console.log(`\u{1F4CB} Shop:      http://localhost:${PORT}/shop.html\n`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
})();
