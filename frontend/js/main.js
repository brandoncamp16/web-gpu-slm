document.addEventListener('DOMContentLoaded', () => {
    const contactForm = document.getElementById('contactForm');
    const submitBtn = document.getElementById('submitBtn');
    const formStatus = document.getElementById('formStatus');

    contactForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        // Reset status message
        formStatus.className = 'form-status';
        formStatus.textContent = '';
        
        // Disable button to prevent double submission
        submitBtn.disabled = true;
        submitBtn.textContent = 'Sending...';

        // Gather data
        const formData = {
            name: document.getElementById('name').value,
            email: document.getElementById('email').value,
            phone: document.getElementById('phone').value,
            message: document.getElementById('message').value
        };

        try {
            // Send to Nginx proxy which forwards to backend:1616
            const response = await fetch('/api/contact', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(formData)
            });

            const data = await response.json();

            if (response.ok) {
                // Success
                formStatus.textContent = 'Message sent successfully! We will be in touch.';
                formStatus.className = 'form-status status-success';
                contactForm.reset();
            } else {
                // Backend error
                formStatus.textContent = data.message || 'Failed to send message. Please try again.';
                formStatus.className = 'form-status status-error';
            }
        } catch (error) {
            // Network or parsing error
            console.error('Error submitting form:', error);
            formStatus.textContent = 'A network error occurred. Please check your connection and try again.';
            formStatus.className = 'form-status status-error';
        } finally {
            // Re-enable button
            submitBtn.disabled = false;
            submitBtn.textContent = 'Send Message';
        }
    });
});