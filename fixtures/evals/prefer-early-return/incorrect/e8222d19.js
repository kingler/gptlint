function logIn(user) {
  if (user.isLoggedIn) {
    // This code violates the rule by not using an early return for logged in users.
    console.log('User already logged in')
    redirectToDashboard()
  }
}

// Generated by gpt-4-0125-preview
