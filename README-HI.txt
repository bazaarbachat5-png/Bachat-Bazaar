Bachat Bazaar - Existing Design + Free IDM-VTON Try-On

Deploy: is folder ko Netlify par deploy karein.
Try-On: browser se yisol/IDM-VTON Hugging Face Space connect hota hai. GEMINI_API_KEY ki zarurat nahi.
Note: Hugging Face ZeroGPU free usage limited hai; unlimited free generation guarantee nahi hai.

Agar purana Netlify function/deployment cache dikhe to Netlify par fresh deploy karein aur browser hard refresh karein.

=== SELLER MOBILE OTP UPDATE ===

Is version mein Seller Register aur Seller Login ke liye Firebase Phone OTP add kiya gaya hai.
Email/password legacy login ko backup ke roop mein rakha gaya hai.

Firebase Console mein:
1) Authentication > Sign-in method > Phone > Enable.
2) Authentication > Settings > Authorized domains mein apna live domain add karein, jaise:
   patient-snowflake-f43c.bazaarbachat5.workers.dev
3) Phone provider ke SMS/region settings check karein.
4) Firestore database existing project mein enabled hona chahiye.

Flow:
Seller Register -> Mobile OTP -> Seller record (pending) -> Admin Approve -> Seller Dashboard
Seller Login -> Mobile OTP -> seller status check -> Dashboard/Pending/Rejected/Suspended

IMPORTANT:
Current app ka legacy Firestore architecture shared 'store' document use karta hai. OTP login UI aur approval flow add kiya gaya hai, lekin production-grade authorization ke liye Firestore data ko per-user/per-seller documents mein migrate karke strict Security Rules lagana recommended hai. Sirf frontend approval ko security boundary na samjhein.
