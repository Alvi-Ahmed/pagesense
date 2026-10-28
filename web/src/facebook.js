const APP_ID = import.meta.env.VITE_FB_APP_ID
const VERSION = 'v26.0'
export const SCOPES =
  'pages_show_list,pages_read_engagement,pages_read_user_content,read_insights,pages_manage_posts'

let sdk
export function loadFacebookSdk() {
  sdk ??= new Promise((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB.init({ appId: APP_ID, version: VERSION, cookie: false, xfbml: false })
      resolve(window.FB)
    }
    const s = document.createElement('script')
    s.src = 'https://connect.facebook.net/en_US/sdk.js'
    s.async = true
    s.onerror = () => reject(new Error('Could not load the Facebook SDK'))
    document.body.appendChild(s)
  })
  return sdk
}

// Resolves with the short-lived user access token.
export async function facebookLogin() {
  const FB = await loadFacebookSdk()
  return new Promise((resolve, reject) => {
    FB.login(
      (res) =>
        res.authResponse
          ? resolve(res.authResponse.accessToken)
          : reject(new Error('Facebook login was cancelled')),
      { scope: SCOPES },
    )
  })
}
