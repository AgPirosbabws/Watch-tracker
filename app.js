import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { 
    getAuth, 
    createUserWithEmailAndPassword, 
    signInWithEmailAndPassword, 
    signOut, 
    onAuthStateChanged,
} from 'firebase/auth';
import { 
    getFirestore, 
    doc, 
    setDoc, 
    getDoc,
    deleteDoc, 
    collection, 
    onSnapshot,
    query,
    where,
    writeBatch,
    serverTimestamp,
    limit,
    orderBy as firestoreOrderBy
} from 'firebase/firestore';

// --- Configuration ---
const firebaseConfigString = typeof __firebase_config !== 'undefined' ? __firebase_config : '{}';
const firebaseConfig = JSON.parse(firebaseConfigString);

const TMDB_API_KEY = 'YOUR_TMDB_API_KEY'; // <--- IMPORTANT: REPLACE THIS!
const TMDB_API_URL = 'https://api.themoviedb.org/3';

// --- Helper Components ---
const Spinner = ({ size = 'h-8 w-8', color = 'border-sky-500' }) => (
    <div className="flex justify-center items-center p-2">
        <div className={`animate-spin rounded-full border-b-2 ${color} ${size}`}></div>
    </div>
);

const Modal = ({ isOpen, onClose, children }) => {
    if (!isOpen) return null;
    return (
        <div className="fixed inset-0 bg-black bg-opacity-60 backdrop-blur-sm flex justify-center items-center z-50 p-4" onClick={onClose}>
            <div className="bg-white dark:bg-gray-800 p-6 rounded-2xl shadow-xl w-full max-w-lg text-center transform transition-all" onClick={e => e.stopPropagation()}>
                {children}
            </div>
        </div>
    );
};

const ErrorModal = ({ message, onClose }) => (
    <Modal isOpen={!!message} onClose={onClose}>
         <h3 className="text-lg font-bold text-red-500 mb-4">An Error Occurred</h3>
         <p className="text-gray-700 dark:text-gray-300 mb-6">{message}</p>
         <button onClick={onClose} className="bg-sky-500 text-white px-4 py-2 rounded-lg hover:bg-sky-600 transition-colors">Close</button>
    </Modal>
);

// --- Main Application ---
export default function App() {
    // --- State Management ---
    const [theme, setTheme] = useState('dark');
    const [screen, setScreen] = useState('loading');
    const [user, setUser] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(null);
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);

    // App Content State
    const [activeTab, setActiveTab] = useState('watched');
    const [watchedList, setWatchedList] = useState([]);
    const [wishlist, setWishlist] = useState([]);
    const [searchResults, setSearchResults] = useState([]);
    const [searchTerm, setSearchTerm] = useState('');
    const [isSearching, setIsSearching] = useState(false);
    
    // Social Feature State
    const [friends, setFriends] = useState([]);
    const [friendRequests, setFriendRequests] = useState([]);
    const [userSearchResults, setUserSearchResults] = useState([]);
    const [userSearchTerm, setUserSearchTerm] = useState('');
    const [isUserSearching, setIsUserSearching] = useState(false);
    const [friendsFeed, setFriendsFeed] = useState([]);
    const [isFeedLoading, setIsFeedLoading] = useState(false);

    // "Where to Watch" State
    const [watchProviders, setWatchProviders] = useState(null);
    const [isProviderModalOpen, setIsProviderModalOpen] = useState(false);

    const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

    // --- Effects ---

    // Initialize Firebase
    useEffect(() => {
        if (firebaseConfig.apiKey) {
            const app = initializeApp(firebaseConfig);
            setAuth(getAuth(app));
            setDb(getFirestore(app));
        } else {
             setError("Firebase configuration is missing.");
        }
    }, []);

    // Auth State Observer
    useEffect(() => {
        if (!auth) return;
        const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
            if (currentUser) {
                setUser(currentUser);
                setUserId(currentUser.uid);
                // Fetch user profile
                const userDocRef = doc(db, `artifacts/${appId}/public/users`, currentUser.uid);
                const userDoc = await getDoc(userDocRef);
                if(userDoc.exists()) {
                    setDisplayName(userDoc.data().displayName);
                }
                setScreen('app');
            } else {
                setUser(null);
                setUserId(null);
                setScreen('login');
                // Clear all user-specific data
                setWatchedList([]);
                setWishlist([]);
                setFriends([]);
                setFriendRequests([]);
                setFriendsFeed([]);
            }
            setIsAuthReady(true);
        });
        return () => unsubscribe();
    }, [auth, db, appId]);
    
    // Data Listeners
    useEffect(() => {
        if (!db || !userId) return;
        
        const watchedPath = `artifacts/${appId}/users/${userId}/watchedList`;
        const wishlistPath = `artifacts/${appId}/users/${userId}/wishlist`;
        const friendsPath = `artifacts/${appId}/users/${userId}/friends`;
        const requestsPath = `artifacts/${appId}/users/${userId}/friendRequests`;

        const unsubWatched = onSnapshot(query(collection(db, watchedPath), firestoreOrderBy('addedAt', 'desc')), snap => setWatchedList(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
        const unsubWishlist = onSnapshot(query(collection(db, wishlistPath), firestoreOrderBy('addedAt', 'desc')), snap => setWishlist(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
        const unsubFriends = onSnapshot(collection(db, friendsPath), snap => setFriends(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
        const unsubRequests = onSnapshot(collection(db, requestsPath), snap => setFriendRequests(snap.docs.map(d => ({ id: d.id, ...d.data() }))));

        return () => { unsubWatched(); unsubWishlist(); unsubFriends(); unsubRequests(); };
    }, [db, userId, appId]);

    // Friends Feed Loader
    useEffect(() => {
        if (friends.length === 0) {
            setFriendsFeed([]);
            return;
        }
        setIsFeedLoading(true);
        const fetchFeeds = async () => {
            const feed = [];
            for (const friend of friends) {
                const friendWatchedPath = `artifacts/${appId}/users/${friend.id}/watchedList`;
                const q = query(collection(db, friendWatchedPath), firestoreOrderBy('addedAt', 'desc'), limit(5));
                const snap = await getDoc(q);
                snap.forEach(doc => {
                    feed.push({ ...doc.data(), id: doc.id, user: friend });
                });
            }
            feed.sort((a, b) => (b.addedAt?.seconds || 0) - (a.addedAt?.seconds || 0));
            setFriendsFeed(feed);
            setIsFeedLoading(false);
        };
        fetchFeeds();
    }, [friends, db, appId]);


    useEffect(() => {
        document.documentElement.classList.toggle('dark', theme === 'dark');
    }, [theme]);


    // --- Auth Functions ---
    const handleSignup = async () => {
        if (!auth || !db) return;
        if (displayName.length < 3) {
            setError("Display name must be at least 3 characters.");
            return;
        }
        setIsLoading(true);
        setError(null);
        try {
            // Check if display name is unique
            const usersRef = collection(db, `artifacts/${appId}/public/users`);
            const q = query(usersRef, where("displayName_lower", "==", displayName.toLowerCase()));
            const nameCheck = await getDoc(q);
            if (!nameCheck.empty) {
                throw new Error("Display name is already taken.");
            }
            
            const userCredential = await createUserWithEmailAndPassword(auth, email, password);
            // Create public user profile
            await setDoc(doc(db, `artifacts/${appId}/public/users`, userCredential.user.uid), {
                displayName: displayName,
                displayName_lower: displayName.toLowerCase()
            });
            // No need to redirect, onAuthStateChanged will handle it
        } catch (err) {
            setError(err.message);
        } finally {
            setIsLoading(false);
        }
    };
    
    const handleLogin = async () => {
        if (!auth) return;
        setIsLoading(true);
        setError(null);
        try {
            await signInWithEmailAndPassword(auth, email, password);
        } catch (err) {
            setError(err.message);
        } finally {
            setIsLoading(false);
        }
    };

    const handleLogout = () => signOut(auth);

    // --- Media Functions ---
    const searchMedia = useCallback(async () => {
        if (!searchTerm.trim() || TMDB_API_KEY === 'YOUR_TMDB_API_KEY') {
            if (TMDB_API_KEY === 'YOUR_TMDB_API_KEY') setError("Please add your TMDb API key.");
            return;
        }
        setIsSearching(true);
        try {
            const res = await fetch(`${TMDB_API_URL}/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(searchTerm)}`);
            const data = await res.json();
            setSearchResults(data.results.filter(item => item.media_type === 'movie' || item.media_type === 'tv'));
        } catch (err) {
            setError("Failed to search media.");
        } finally {
            setIsSearching(false);
        }
    }, [searchTerm]);

    const addToList = async (item, listType) => {
        if (!db || !userId) return;
        const listPath = listType === 'watched' ? `artifacts/${appId}/users/${userId}/watchedList` : `artifacts/${appId}/users/${userId}/wishlist`;
        try {
            const detailUrl = `${TMDB_API_URL}/${item.media_type}/${item.id}?api_key=${TMDB_API_KEY}`;
            const detailRes = await fetch(detailUrl);
            const detailData = await detailRes.json();
            const runtime = detailData.runtime || (detailData.episode_run_time ? detailData.episode_run_time[0] : 0) || 0;

            await setDoc(doc(db, listPath, String(item.id)), {
                title: item.title || item.name,
                poster_path: item.poster_path,
                media_type: item.media_type,
                release_date: item.release_date || item.first_air_date,
                runtime: runtime,
                addedAt: serverTimestamp(),
            });
        } catch (err) {
            setError(`Could not add to ${listType} list.`);
        }
    };

    const removeFromList = (itemId, listType) => {
        if (!db || !userId) return;
        const listPath = listType === 'watched' ? `artifacts/${appId}/users/${userId}/watchedList` : `artifacts/${appId}/users/${userId}/wishlist`;
        deleteDoc(doc(db, listPath, String(itemId)));
    };

    const fetchWatchProviders = async (item) => {
        setIsProviderModalOpen(true);
        setWatchProviders({ loading: true });
        try {
            const res = await fetch(`${TMDB_API_URL}/${item.media_type}/${item.id}/watch/providers?api_key=${TMDB_API_KEY}`);
            const data = await res.json();
            setWatchProviders({ data: data.results.IN, loading: false, item: item }); // Filter for India
        } catch (err) {
            setError("Could not fetch providers.");
            setWatchProviders({ loading: false });
        }
    };

    // --- Social Functions ---
    const searchUsers = async () => {
        if(!userSearchTerm.trim()) return;
        setIsUserSearching(true);
        const usersRef = collection(db, `artifacts/${appId}/public/users`);
        const q = query(usersRef, where('displayName_lower', '>=', userSearchTerm.toLowerCase()), where('displayName_lower', '<=', userSearchTerm.toLowerCase() + '\uf8ff'));
        const snap = await getDoc(q);
        const users = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(u => u.id !== userId);
        setUserSearchResults(users);
        setIsUserSearching(false);
    };
    
    const sendFriendRequest = async (targetUser) => {
        const requestPath = `artifacts/${appId}/users/${targetUser.id}/friendRequests`;
        await setDoc(doc(db, requestPath, userId), {
            displayName: displayName,
            addedAt: serverTimestamp()
        });
    };
    
    const handleFriendRequest = async (request, action) => {
        if (action === 'accept') {
            const batch = writeBatch(db);
            // Add to own friends list
            batch.set(doc(db, `artifacts/${appId}/users/${userId}/friends`, request.id), { displayName: request.displayName });
            // Add to their friends list
            batch.set(doc(db, `artifacts/${appId}/users/${request.id}/friends`, userId), { displayName: displayName });
            // Delete request
            batch.delete(doc(db, `artifacts/${appId}/users/${userId}/friendRequests`, request.id));
            await batch.commit();
        } else { // Decline
            await deleteDoc(doc(db, `artifacts/${appId}/users/${userId}/friendRequests`, request.id));
        }
    };

    // --- RENDER LOGIC ---

    if (screen === 'loading' || !isAuthReady) {
        return <div className="min-h-screen bg-gray-900 flex items-center justify-center"><Spinner /></div>;
    }

    if (screen === 'login' || screen === 'signup') {
        return <AuthScreen isLogin={screen==='login'} setScreen={setScreen} email={email} setEmail={setEmail} password={password} setPassword={setPassword} displayName={displayName} setDisplayName={setDisplayName} handleLogin={handleLogin} handleSignup={handleSignup} isLoading={isLoading} error={error} theme={theme} setTheme={setTheme} />;
    }

    // Main App View
    return (
        <div className="min-h-screen bg-gray-100 dark:bg-gray-900 text-gray-900 dark:text-gray-100 transition-colors">
            <ErrorModal message={error} onClose={() => setError(null)} />
            <WhereToWatchModal isOpen={isProviderModalOpen} onClose={() => setIsProviderModalOpen(false)} providers={watchProviders} />
            
            <header className="sticky top-0 bg-white/70 dark:bg-gray-800/70 backdrop-blur-lg z-10 shadow-sm">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="flex justify-between items-center py-4">
                         <h1 className="text-2xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-sky-400 to-blue-500">WatchTracker</h1>
                         <div className="flex items-center gap-4">
                             <span className="font-semibold hidden sm:block">{displayName}</span>
                             <ThemeToggle theme={theme} setTheme={setTheme} />
                             <button onClick={handleLogout} className="bg-red-500 text-white px-3 py-1.5 rounded-lg hover:bg-red-600 text-sm font-semibold">Logout</button>
                         </div>
                    </div>
                    <nav className="flex space-x-4 border-b border-gray-200 dark:border-gray-700">
                        {['watched', 'wishlist', 'search', 'friends'].map(tab => 
                            <button key={tab} onClick={() => setActiveTab(tab)} className={`capitalize py-3 px-1 text-sm font-medium transition-colors ${activeTab === tab ? 'border-b-2 border-sky-500 text-sky-500' : 'text-gray-500 dark:text-gray-400 hover:text-sky-500'}`}>
                                {tab}
                            </button>
                        )}
                    </nav>
                </div>
            </header>

            <main className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8">
                {activeTab === 'watched' && <MediaList title="My Watched List" list={watchedList} onRemove={(id) => removeFromList(id, 'watched')} fetchProviders={fetchWatchProviders} isWatchedList={true}/>}
                {activeTab === 'wishlist' && <MediaList title="My Wishlist" list={wishlist} onRemove={(id) => removeFromList(id, 'wishlist')} fetchProviders={fetchWatchProviders} isWatchedList={false}/>}
                {activeTab === 'search' && <SearchView searchTerm={searchTerm} setSearchTerm={setSearchTerm} searchResults={searchResults} isSearching={isSearching} searchMedia={searchMedia} addToList={addToList} />}
                {activeTab === 'friends' && <FriendsTab userSearchTerm={userSearchTerm} setUserSearchTerm={setUserSearchTerm} searchUsers={searchUsers} userSearchResults={userSearchResults} sendFriendRequest={sendFriendRequest} friends={friends} friendRequests={friendRequests} handleFriendRequest={handleFriendRequest} friendsFeed={friendsFeed} isFeedLoading={isFeedLoading} fetchProviders={fetchWatchProviders} />}
            </main>
        </div>
    );
}

// Sub-Components for cleaner structure

const AuthScreen = ({ isLogin, setScreen, email, setEmail, password, setPassword, displayName, setDisplayName, handleLogin, handleSignup, isLoading, error, theme, setTheme }) => (
    <div className="min-h-screen bg-gray-100 dark:bg-gray-900 flex flex-col justify-center items-center p-4">
        <div className="absolute top-4 right-4"><ThemeToggle theme={theme} setTheme={setTheme} /></div>
        <div className="w-full max-w-sm p-8 space-y-6 bg-white dark:bg-gray-800 rounded-2xl shadow-lg">
            <h2 className="text-3xl font-bold text-center text-gray-900 dark:text-white">{isLogin ? 'Welcome Back' : 'Create Account'}</h2>
            {error && <p className="text-red-500 text-sm text-center">{error}</p>}
            <div className="space-y-4">
                {!isLogin && (
                    <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)} className="w-full p-3 bg-gray-100 dark:bg-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-500" placeholder="Unique Display Name" />
                )}
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} className="w-full p-3 bg-gray-100 dark:bg-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-500" placeholder="you@example.com" />
                <input type="password" value={password} onChange={e => setPassword(e.target.value)} className="w-full p-3 bg-gray-100 dark:bg-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-500" placeholder="••••••••" />
            </div>
            <button onClick={isLogin ? handleLogin : handleSignup} disabled={isLoading} className="w-full p-3 bg-sky-500 text-white rounded-lg font-bold hover:bg-sky-600 flex justify-center">{isLoading ? <Spinner size="h-6 w-6" /> : (isLogin ? 'Log In' : 'Sign Up')}</button>
            <p className="text-center text-sm text-gray-600 dark:text-gray-400">
                {isLogin ? "Don't have an account? " : "Already have an account? "}
                <button onClick={() => setScreen(isLogin ? 'signup' : 'login')} className="font-bold text-sky-500 hover:underline">{isLogin ? 'Sign Up' : 'Log In'}</button>
            </p>
        </div>
    </div>
);

const MediaCard = ({ item, onRemove, onAdd, onWishlist, onWatch, isWatched, isInWishlist }) => (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md overflow-hidden flex">
        <img src={item.poster_path ? `https://image.tmdb.org/t/p/w200${item.poster_path}` : 'https://placehold.co/200x300/e2e8f0/4a5568?text=N/A'} alt={item.title} className="w-24 h-36 object-cover flex-shrink-0" onError={(e) => { e.target.onerror = null; e.target.src='https://placehold.co/200x300/e2e8f0/4a5568?text=N/A'; }}/>
        <div className="p-3 flex flex-col justify-between flex-grow">
            <div>
                <h3 className="font-bold text-md text-gray-800 dark:text-white">{item.title || item.name}</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">{(item.release_date || 'N/A').split('-')[0]}</p>
                 {item.user && <p className="text-xs text-sky-400 mt-1">Watched by {item.user.displayName}</p>}
            </div>
            <div className="flex flex-wrap gap-2 mt-2">
                {onRemove && <button onClick={() => onRemove(item.id)} className="text-xs bg-red-500 text-white px-2 py-1 rounded-full hover:bg-red-600">Remove</button>}
                {onAdd && <button onClick={() => onAdd(item, 'watched')} disabled={isWatched} className="text-xs bg-green-500 text-white px-2 py-1 rounded-full hover:bg-green-600 disabled:bg-gray-400">Watched</button>}
                {onWishlist && <button onClick={() => onWishlist(item, 'wishlist')} disabled={isInWishlist} className="text-xs bg-yellow-500 text-white px-2 py-1 rounded-full hover:bg-yellow-600 disabled:bg-gray-400">Wishlist</button>}
                {onWatch && <button onClick={() => onWatch(item)} className="text-xs bg-sky-500 text-white px-2 py-1 rounded-full hover:bg-sky-600">Where to Watch</button>}
            </div>
        </div>
    </div>
);

const MediaList = ({ title, list, onRemove, fetchProviders, isWatchedList }) => (
    <div>
        <h2 className="text-2xl font-bold mb-4">{title} ({list.length})</h2>
        {list.length > 0 ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                {list.map(item => <MediaCard key={item.id} item={item} onRemove={onRemove} onWatch={fetchProviders} />)}
            </div>
        ) : (
            <p className="text-gray-500 mt-6 text-center">This list is empty.</p>
        )}
    </div>
);

const SearchView = ({ searchTerm, setSearchTerm, searchResults, isSearching, searchMedia, addToList }) => (
     <div>
        <h2 className="text-2xl font-bold mb-4">Find Movies & Series</h2>
        <div className="flex gap-2 mb-8">
            <input type="text" value={searchTerm} onChange={e => setSearchTerm(e.target.value)} onKeyPress={e => e.key === 'Enter' && searchMedia()} placeholder="Search for a title..." className="w-full p-3 bg-white dark:bg-gray-700 rounded-lg focus:outline-none ring-1 ring-gray-300 dark:ring-gray-600 focus:ring-sky-500" />
            <button onClick={searchMedia} disabled={isSearching} className="bg-sky-500 text-white px-4 rounded-lg font-semibold hover:bg-sky-600 flex items-center">{isSearching ? <Spinner size="h-6 w-6"/> : 'Search'}</button>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
            {searchResults.map(item => <MediaCard key={item.id} item={item} onAdd={addToList} onWishlist={addToList} onWatch={()=>{}}/>)}
        </div>
    </div>
);

const FriendsTab = ({ userSearchTerm, setUserSearchTerm, searchUsers, userSearchResults, sendFriendRequest, friends, friendRequests, handleFriendRequest, friendsFeed, isFeedLoading, fetchProviders }) => {
    const [subTab, setSubTab] = useState('feed');
    
    return (
        <div>
            <div className="flex space-x-2 border-b border-gray-200 dark:border-gray-700 mb-6">
                {['feed', 'my friends', 'find users', `requests (${friendRequests.length})`].map(tab => 
                    <button key={tab} onClick={() => setSubTab(tab.split(' ')[0])} className={`capitalize py-2 px-3 text-sm font-medium transition-colors ${subTab === tab.split(' ')[0] ? 'bg-sky-100 dark:bg-sky-900/50 text-sky-600 dark:text-sky-400 rounded-t-lg' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800'}`}>
                        {tab}
                    </button>
                )}
            </div>
            
            {subTab === 'feed' && (
                <div>
                    <h3 className="text-xl font-bold mb-4">Friends Feed</h3>
                    {isFeedLoading && <Spinner />}
                    {friendsFeed.length > 0 ? (
                         <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                             {friendsFeed.map(item => <MediaCard key={`${item.user.id}-${item.id}`} item={item} onWatch={fetchProviders} />)}
                         </div>
                    ) : !isFeedLoading && <p className="text-center text-gray-500 mt-6">Your friends haven't watched anything recently, or you haven't added any friends yet!</p>}
                </div>
            )}
             {subTab === 'my' && (
                <div>
                    <h3 className="text-xl font-bold mb-4">My Friends ({friends.length})</h3>
                     {friends.map(f => <div key={f.id} className="bg-white dark:bg-gray-800 p-3 rounded-lg shadow">{f.displayName}</div>)}
                </div>
            )}
            {subTab === 'find' && (
                <div>
                    <h3 className="text-xl font-bold mb-4">Find Users</h3>
                    <div className="flex gap-2 mb-4">
                         <input type="text" value={userSearchTerm} onChange={e => setUserSearchTerm(e.target.value)} placeholder="Search by display name..." className="w-full p-3 bg-white dark:bg-gray-700 rounded-lg"/>
                         <button onClick={searchUsers} className="bg-sky-500 text-white px-4 rounded-lg">Search</button>
                    </div>
                    {userSearchResults.map(u => <div key={u.id} className="flex justify-between items-center bg-white dark:bg-gray-800 p-3 rounded-lg"><span>{u.displayName}</span><button onClick={()=> sendFriendRequest(u)} className="text-xs bg-blue-500 text-white px-2 py-1 rounded-full">Add Friend</button></div>)}
                </div>
            )}
            {subTab === 'requests' && (
                 <div>
                    <h3 className="text-xl font-bold mb-4">Friend Requests</h3>
                    {friendRequests.map(req => (
                        <div key={req.id} className="flex justify-between items-center bg-white dark:bg-gray-800 p-3 rounded-lg mb-2">
                            <span>{req.displayName}</span>
                            <div className="flex gap-2">
                                <button onClick={() => handleFriendRequest(req, 'accept')} className="text-xs bg-green-500 text-white px-2 py-1 rounded-full">Accept</button>
                                <button onClick={() => handleFriendRequest(req, 'decline')} className="text-xs bg-red-500 text-white px-2 py-1 rounded-full">Decline</button>
                            </div>
                        </div>
                    ))}
                     {friendRequests.length === 0 && <p className="text-center text-gray-500 mt-6">No new friend requests.</p>}
                </div>
            )}

        </div>
    );
};


const WhereToWatchModal = ({ isOpen, onClose, providers }) => {
    if (!providers) return null;

    const renderProviders = (provs) => {
        if(!provs || provs.length === 0) return <p className="text-sm text-gray-500">Not available on major streaming services in India.</p>;
        return (
            <div className="flex flex-wrap justify-center gap-4">
                {provs.map(p => (
                    <a key={p.provider_id} href={providers.data?.link} target="_blank" rel="noopener noreferrer" className="flex flex-col items-center gap-2 transform hover:scale-110 transition-transform">
                        <img src={`https://image.tmdb.org/t/p/w92${p.logo_path}`} alt={p.provider_name} className="w-16 h-16 rounded-xl shadow-lg" />
                        <span className="text-xs text-gray-600 dark:text-gray-400">{p.provider_name}</span>
                    </a>
                ))}
            </div>
        );
    }
    
    return (
        <Modal isOpen={isOpen} onClose={onClose}>
            {providers.loading ? <Spinner /> : (
                <div className="space-y-4">
                     <h3 className="text-xl font-bold">Where to Watch <span className="text-sky-500">{providers.item?.title || providers.item?.name}</span></h3>
                     <div className="space-y-3">
                        {providers.data?.flatrate && (
                            <div>
                                <h4 className="font-semibold text-lg mb-2">Stream</h4>
                                {renderProviders(providers.data.flatrate)}
                            </div>
                        )}
                         {providers.data?.rent && (
                            <div>
                                <h4 className="font-semibold text-lg mt-4 mb-2">Rent</h4>
                                {renderProviders(providers.data.rent)}
                            </div>
                        )}
                         {providers.data?.buy && (
                            <div>
                                <h4 className="font-semibold text-lg mt-4 mb-2">Buy</h4>
                                {renderProviders(providers.data.buy)}
                            </div>
                        )}
                        {!providers.data?.flatrate && !providers.data?.rent && !providers.data?.buy && renderProviders([])}
                     </div>
                </div>
            )}
        </Modal>
    );
}

const ThemeToggle = ({ theme, setTheme }) => {
    const toggleTheme = () => setTheme(theme === 'dark' ? 'light' : 'dark');
    return (
        <button onClick={toggleTheme} className="p-2 rounded-full bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200">
            {theme === 'dark' ? '☀️' : '🌙'}
        </button>
    );
};
