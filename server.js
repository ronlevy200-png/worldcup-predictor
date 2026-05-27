const express = require('express');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;

// הגדרת תיקיית public כתיקייה סטטית (כדי שימצא את index.html)
app.use(express.static(path.join(__dirname, 'public')));

// במידה וניגשים לנתיב הראשי, שיציג את index.html מתוך public
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});